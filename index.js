/**
 * WHATSAPP SERVER - PromptLab
 * Servidor Node.js para integração WhatsApp
 *
 * Funcionalidades:
 * - Gerar QR Code para conectar WhatsApp
 * - Manter sessão ativa
 * - Enviar mensagens agendadas
 * - API REST para comunicar com frontend
 */

const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = 'https://fbetadyrpcqbivlrvpen.supabase.co';
// Service role key para bypass RLS no servidor backend
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiZXRhZHlycGNxYml2bHJ2cGVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDg3MDE5NiwiZXhwIjoyMDgwNDQ2MTk2fQ.kzu8ncnk1Tj1FYwMuKQKZMXFLiuDxtthN1k1SsCVDUk';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Inicializar Express
const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// ARMAZENAMENTO DE SESSÕES (por user)
// ==========================================
const userSessions = new Map(); // userId -> { client, qrCode, status }

// ==========================================
// CONFIGURAÇÃO AI AUTO-REPLY
// ==========================================
const SUPABASE_FUNCTIONS_URL = 'https://fbetadyrpcqbivlrvpen.supabase.co/functions/v1';
const userAISettings = new Map(); // userId -> { enabled, aiLevel, systemPrompt, conversationHistory }

// Cache de histórico de conversas por contacto (para contexto)
const conversationCache = new Map(); // `${userId}:${contactNumber}` -> [messages]
const MAX_HISTORY_MESSAGES = 10; // Máximo de mensagens no histórico por conversa

// Cache de conhecimento do utilizador (posts + agenda) - atualizado periodicamente
const userKnowledgeCache = new Map(); // userId -> { posts, agenda, lastUpdated }
const KNOWLEDGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Buscar posts do feed do utilizador (base de conhecimento)
 * Todos os posts pertencem à conta do utilizador (privados)
 */
async function getUserFeedPosts(userId) {
    try {
        const { data, error } = await supabase
            .from('posts')
            .select('title, summary, content')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`[AI] Error fetching posts:`, error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error(`[AI] Error fetching posts:`, err);
        return [];
    }
}

/**
 * Buscar agenda de disponibilidades do utilizador
 */
async function getUserAvailability(userId) {
    try {
        // Buscar eventos da agenda (próximos 7 dias)
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const { data, error } = await supabase
            .from('appointments')
            .select('client_name, date, start_time, duration, type, notes')
            .eq('user_id', userId)
            .gte('date', now.toISOString().split('T')[0])
            .lte('date', weekFromNow.toISOString().split('T')[0])
            .order('date', { ascending: true })
            .order('start_time', { ascending: true });

        if (error) {
            console.error(`[AI] Error fetching agenda:`, error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error(`[AI] Error fetching agenda:`, err);
        return [];
    }
}

/**
 * Obter conhecimento do utilizador (com cache)
 */
async function getUserKnowledge(userId) {
    const cached = userKnowledgeCache.get(userId);
    const now = Date.now();

    // Retornar cache se ainda válido
    if (cached && (now - cached.lastUpdated) < KNOWLEDGE_CACHE_TTL) {
        return cached;
    }

    // Buscar dados frescos
    const [posts, agenda] = await Promise.all([
        getUserFeedPosts(userId),
        getUserAvailability(userId)
    ]);

    const knowledge = {
        posts,
        agenda,
        lastUpdated: now
    };

    userKnowledgeCache.set(userId, knowledge);
    console.log(`[AI] Knowledge cache updated for user ${userId}: ${posts.length} posts, ${agenda.length} events`);

    return knowledge;
}

/**
 * Formatar conhecimento para incluir no contexto da AI
 * Modo eficiência: usa apenas títulos e sumários para economizar tokens
 */
function formatKnowledgeContext(knowledge) {
    let context = '';

    // Formatar posts do feed (modo eficiência - apenas título e sumário)
    if (knowledge.posts && knowledge.posts.length > 0) {
        context += '\n\n=== BASE DE CONHECIMENTO (Posts do Feed) ===\n';
        context += `Total: ${knowledge.posts.length} posts\n\n`;
        knowledge.posts.forEach((post, i) => {
            context += `• ${post.title}`;
            if (post.summary) {
                context += `: ${post.summary}`;
            }
            context += '\n';
        });
    }

    // Formatar agenda de disponibilidades
    if (knowledge.agenda && knowledge.agenda.length > 0) {
        context += '\n\n=== AGENDA (Próximos 7 dias) ===\n';
        knowledge.agenda.forEach(event => {
            const date = new Date(event.date).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
            context += `• ${date}: ${event.client_name || event.type}`;
            if (event.start_time) {
                context += ` (${event.start_time}`;
                if (event.duration) {
                    // Calcular hora de fim baseada na duração
                    const [h, m] = event.start_time.split(':').map(Number);
                    const endMinutes = h * 60 + m + event.duration;
                    const endH = Math.floor(endMinutes / 60);
                    const endM = endMinutes % 60;
                    context += `-${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
                }
                context += ')';
            }
            context += '\n';
        });
    } else {
        context += '\n\n=== AGENDA ===\nSem eventos agendados.\n';
    }

    return context;
}

/**
 * Chamar a AI para gerar resposta
 */
async function getAIResponse(userId, contactNumber, userMessage) {
    const settings = userAISettings.get(userId);
    if (!settings || !settings.enabled) {
        return null;
    }

    try {
        // Obter/criar histórico de conversa para este contacto
        const cacheKey = `${userId}:${contactNumber}`;
        let history = conversationCache.get(cacheKey) || [];

        // Adicionar mensagem do utilizador ao histórico
        history.push({ role: 'user', content: userMessage });

        // Limitar tamanho do histórico
        if (history.length > MAX_HISTORY_MESSAGES) {
            history = history.slice(-MAX_HISTORY_MESSAGES);
        }

        // Construir system prompt personalizado
        const defaultPrompt = `Você é um assistente AI que responde mensagens WhatsApp em nome do utilizador.
Mantenha respostas concisas e amigáveis, apropriadas para WhatsApp.
Responda no mesmo idioma da mensagem recebida.
Não use formatação markdown - apenas texto simples.

AGENDAMENTOS:
Você pode agendar compromissos quando o cliente solicitar. Verifique a disponibilidade na agenda antes de confirmar.
Para criar um agendamento, responda com o formato especial no FINAL da sua mensagem:
[AGENDAR: YYYY-MM-DD HH:MM duração_minutos "Nome do Cliente" "notas opcionais"]

Exemplo: Se o cliente pedir para agendar dia 20 de janeiro às 14h:
"Perfeito! Vou agendar para dia 20 de janeiro às 14:00. Confirmo o agendamento!
[AGENDAR: 2026-01-20 14:00 60 "João Silva" "Agendado via WhatsApp"]"

Se o horário não estiver disponível, sugira alternativas baseadas na agenda.`;

        let systemPrompt = settings.systemPrompt || defaultPrompt;

        // Sempre adicionar a data atual ao prompt (mesmo com prompt personalizado)
        const hoje = new Date();
        const dataInfo = `\n\nINFORMAÇÃO TEMPORAL IMPORTANTE:
- Data de hoje: ${hoje.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
- Dia da semana: ${hoje.toLocaleDateString('pt-PT', { weekday: 'long' })}
- Amanhã será: ${new Date(hoje.getTime() + 24*60*60*1000).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
        systemPrompt += dataInfo;

        // Buscar e adicionar conhecimento do utilizador (posts do feed + agenda)
        const knowledge = await getUserKnowledge(userId);
        const knowledgeContext = formatKnowledgeContext(knowledge);

        // Adicionar contexto de conhecimento ao system prompt
        const fullContext = systemPrompt + knowledgeContext;

        console.log(`[AI] Calling AI for user ${userId}, contact ${contactNumber} (knowledge: ${knowledge.posts.length} posts, ${knowledge.agenda.length} events)`);

        // Chamar Supabase Edge Function
        const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/ask-claude`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
                prompt: userMessage,
                context: fullContext,
                aiLevel: settings.aiLevel || 2,
                conversationHistory: history.slice(0, -1) // Excluir a mensagem atual (já vai no prompt)
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error(`[AI] Error from AI:`, data.error);
            return null;
        }

        let aiReply = data.reply;

        // Verificar se a AI quer criar um agendamento
        const appointmentMatch = aiReply.match(/\[AGENDAR:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\d+)\s+"([^"]+)"(?:\s+"([^"]*)")?\]/);
        if (appointmentMatch) {
            const [fullMatch, date, time, duration, clientName, notes] = appointmentMatch;
            console.log(`[AI] Detected appointment request: ${date} ${time} for ${clientName}`);

            // Verificar disponibilidade e criar agendamento
            const isAvailable = await checkAvailability(userId, date, time, parseInt(duration));
            if (isAvailable) {
                const appointment = await createAppointment(userId, {
                    date,
                    start: time,
                    duration: parseInt(duration),
                    client: clientName,
                    phone: contactNumber,
                    notes: notes || 'Agendado via WhatsApp AI'
                });

                if (appointment) {
                    console.log(`[AI] Appointment created successfully: ${appointment.id}`);
                    // Remover o comando da resposta visível
                    aiReply = aiReply.replace(fullMatch, '').trim();
                } else {
                    // Falhou ao criar, remover comando e avisar
                    aiReply = aiReply.replace(fullMatch, '(Houve um erro ao criar o agendamento. Por favor tente novamente.)').trim();
                }
            } else {
                // Horário não disponível
                console.log(`[AI] Time slot not available: ${date} ${time}`);
                aiReply = aiReply.replace(fullMatch, '(Este horário já não está disponível. Por favor escolha outro horário.)').trim();
            }
        }

        // Adicionar resposta da AI ao histórico
        history.push({ role: 'assistant', content: aiReply });
        conversationCache.set(cacheKey, history);

        console.log(`[AI] Response generated (${data.model}): ${aiReply.substring(0, 50)}...`);

        return aiReply;

    } catch (err) {
        console.error(`[AI] Error calling AI:`, err);
        return null;
    }
}

/**
 * Carregar configurações AI do utilizador do Supabase
 */
async function loadUserAISettings(userId) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('ai_auto_reply, ai_level, ai_system_prompt')
            .eq('id', userId)
            .single();

        if (error || !data) {
            return { enabled: false, aiLevel: 2, systemPrompt: null };
        }

        return {
            enabled: data.ai_auto_reply || false,
            aiLevel: data.ai_level || 2,
            systemPrompt: data.ai_system_prompt || null
        };
    } catch (err) {
        console.error(`[AI] Error loading settings:`, err);
        return { enabled: false, aiLevel: 2, systemPrompt: null };
    }
}

/**
 * Criar ou obter cliente WhatsApp para um user
 */
function getOrCreateClient(userId) {
    if (userSessions.has(userId)) {
        return userSessions.get(userId);
    }

    const session = {
        client: null,
        qrCode: null,
        status: 'disconnected', // disconnected, qr_ready, connected
        phone: null
    };

    // Criar cliente WhatsApp com autenticação local (guarda sessão)
    const puppeteerConfig = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    };

    // Use system Chromium if available (Docker/Railway)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: puppeteerConfig
    });

    // Evento: QR Code gerado
    client.on('qr', async (qr) => {
        console.log(`[WA ${userId}] QR Code gerado`);
        session.qrCode = await qrcode.toDataURL(qr);
        session.status = 'qr_ready';
    });

    // Evento: Autenticado com sucesso
    client.on('authenticated', () => {
        console.log(`[WA ${userId}] Autenticado!`);
        session.status = 'authenticated';
    });

    // Evento: Pronto para usar
    client.on('ready', async () => {
        console.log(`[WA ${userId}] Pronto!`);
        session.status = 'connected';
        session.qrCode = null;

        // PATCH: Desactivar sendSeen para evitar bug markedUnread
        try {
            await client.pupPage.evaluate(() => {
                window.WWebJS.sendSeen = async () => { return true; };
            });
            console.log(`[WA ${userId}] Patch sendSeen aplicado`);
        } catch (e) {
            console.log(`[WA ${userId}] Aviso: não foi possível aplicar patch sendSeen`);
        }

        // Guardar número do telefone
        const info = client.info;
        session.phone = info.wid.user;

        // Atualizar status no Supabase
        await updateUserWhatsAppStatus(userId, 'connected', session.phone);

        // Carregar configurações AI do utilizador
        const aiSettings = await loadUserAISettings(userId);
        userAISettings.set(userId, aiSettings);
        console.log(`[AI ${userId}] Settings carregados: enabled=${aiSettings.enabled}, level=${aiSettings.aiLevel}`);
    });

    // Evento: Desconectado
    client.on('disconnected', async (reason) => {
        console.log(`[WA ${userId}] Desconectado: ${reason}`);
        session.status = 'disconnected';
        session.qrCode = null;

        await updateUserWhatsAppStatus(userId, 'disconnected', null);
        userSessions.delete(userId);
    });

    // Evento: Mensagem recebida
    client.on('message', async (message) => {
        // Ignorar mensagens de grupos e status
        if (message.from.includes('@g.us') || message.from === 'status@broadcast') {
            return;
        }

        // Ignorar mensagens próprias
        if (message.fromMe) {
            return;
        }

        const contactNumber = message.from.replace('@c.us', '');
        console.log(`[WA ${userId}] Mensagem recebida de ${contactNumber}: ${message.body}`);

        // Guardar mensagem no Supabase
        await saveIncomingMessage(userId, message);

        // === AI AUTO-REPLY ===
        // Verificar se AI auto-reply está ativo para este utilizador
        const settings = userAISettings.get(userId);
        if (settings && settings.enabled && message.body && message.body.trim()) {
            console.log(`[AI ${userId}] AI auto-reply ativo, a processar mensagem...`);

            try {
                // Obter resposta da AI
                const aiReply = await getAIResponse(userId, contactNumber, message.body);

                if (aiReply) {
                    // Enviar resposta via WhatsApp
                    await message.reply(aiReply);

                    // Guardar resposta no Supabase
                    await supabase
                        .from('whatsapp_messages')
                        .insert({
                            user_id: userId,
                            from_number: session.phone,
                            to_number: contactNumber,
                            body: aiReply,
                            type: 'sent',
                            is_ai_reply: true,
                            timestamp: new Date().toISOString()
                        });

                    console.log(`[AI ${userId}] Resposta enviada para ${contactNumber}`);
                }
            } catch (aiErr) {
                console.error(`[AI ${userId}] Erro ao responder:`, aiErr);
            }
        }
    });

    session.client = client;
    userSessions.set(userId, session);

    return session;
}

/**
 * Atualizar status WhatsApp do user no Supabase
 */
async function updateUserWhatsAppStatus(userId, status, phone) {
    try {
        await supabase
            .from('profiles')
            .update({
                whatsapp_status: status,
                whatsapp_phone: phone,
                whatsapp_updated_at: new Date().toISOString()
            })
            .eq('id', userId);
    } catch (err) {
        console.error(`[DB] Erro ao atualizar status:`, err);
    }
}

/**
 * Guardar mensagem recebida no Supabase
 */
async function saveIncomingMessage(userId, message) {
    try {
        await supabase
            .from('whatsapp_messages')
            .insert({
                user_id: userId,
                from_number: message.from.replace('@c.us', ''),
                to_number: message.to.replace('@c.us', ''),
                body: message.body,
                type: 'received',
                timestamp: new Date(message.timestamp * 1000).toISOString()
            });
    } catch (err) {
        console.error(`[DB] Erro ao guardar mensagem:`, err);
    }
}

// ==========================================
// API ENDPOINTS
// ==========================================

/**
 * GET /health - Verificar se servidor está online
 */
app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: new Date().toISOString() });
});

/**
 * POST /connect - Iniciar conexão WhatsApp (gera QR Code)
 */
app.post('/connect', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    try {
        const session = getOrCreateClient(userId);

        // Se já conectado, retornar status
        if (session.status === 'connected') {
            return res.json({
                status: 'connected',
                phone: session.phone
            });
        }

        // Se QR já está pronto, retornar
        if (session.status === 'qr_ready' && session.qrCode) {
            return res.json({
                status: 'qr_ready',
                qrCode: session.qrCode
            });
        }

        // Inicializar cliente (gera QR)
        if (session.status === 'disconnected') {
            session.client.initialize();
            session.status = 'initializing';
        }

        // Aguardar QR Code (max 30 segundos)
        let attempts = 0;
        const maxAttempts = 30;

        while (!session.qrCode && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (session.qrCode) {
            return res.json({
                status: 'qr_ready',
                qrCode: session.qrCode
            });
        }

        return res.json({
            status: session.status,
            message: 'A inicializar... tente novamente em alguns segundos'
        });

    } catch (err) {
        console.error(`[API] Erro ao conectar:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /status/:userId - Obter status da conexão
 */
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const session = userSessions.get(userId);

    if (!session) {
        return res.json({ status: 'disconnected' });
    }

    res.json({
        status: session.status,
        phone: session.phone,
        hasQR: !!session.qrCode
    });
});

/**
 * POST /disconnect - Desconectar WhatsApp
 */
app.post('/disconnect', async (req, res) => {
    const { userId } = req.body;
    const session = userSessions.get(userId);

    if (session && session.client) {
        await session.client.logout();
        userSessions.delete(userId);
    }

    res.json({ status: 'disconnected' });
});

/**
 * POST /send - Enviar mensagem
 */
app.post('/send', async (req, res) => {
    const { userId, to, message } = req.body;

    if (!userId || !to || !message) {
        return res.status(400).json({ error: 'userId, to e message são obrigatórios' });
    }

    const session = userSessions.get(userId);

    if (!session || session.status !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    try {
        const cleanNumber = to.replace(/\D/g, '');
        const chatId = cleanNumber + '@c.us';
        console.log(`[WA] Tentando enviar para: ${chatId}`);

        // Enviar mensagem com tratamento especial para o bug markedUnread
        let result;
        let messageSent = false;
        try {
            result = await session.client.sendMessage(chatId, message);
            messageSent = true;
            console.log(`[WA] Mensagem enviada! ID: ${result.id._serialized}`);
        } catch (sendErr) {
            // Verificar se é o bug markedUnread (mensagem foi enviada mas sendSeen falhou)
            if (sendErr.message && sendErr.message.includes('markedUnread')) {
                console.log(`[WA] Bug markedUnread ignorado - mensagem foi enviada`);
                messageSent = true;
            } else {
                throw sendErr;
            }
        }

        if (messageSent) {
            // Guardar mensagem enviada no Supabase
            await supabase
                .from('whatsapp_messages')
                .insert({
                    user_id: userId,
                    from_number: session.phone,
                    to_number: cleanNumber,
                    body: message,
                    type: 'sent',
                    timestamp: new Date().toISOString()
                });

            res.json({ success: true, message: 'Mensagem enviada!' });
        }

    } catch (err) {
        console.error(`[API] Erro ao enviar:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /schedule - Agendar mensagem
 */
app.post('/schedule', async (req, res) => {
    const { userId, to, message, scheduledAt } = req.body;

    if (!userId || !to || !message || !scheduledAt) {
        return res.status(400).json({ error: 'userId, to, message e scheduledAt são obrigatórios' });
    }

    try {
        const { data, error } = await supabase
            .from('scheduled_messages')
            .insert({
                user_id: userId,
                to_number: to.replace(/\D/g, ''),
                message: message,
                scheduled_at: scheduledAt,
                status: 'pending'
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, scheduled: data });

    } catch (err) {
        console.error(`[API] Erro ao agendar:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /scheduled/:userId - Listar mensagens agendadas
 */
app.get('/scheduled/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const { data, error } = await supabase
            .from('scheduled_messages')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .order('scheduled_at', { ascending: true });

        if (error) throw error;

        res.json({ scheduled: data });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /scheduled/:id - Cancelar mensagem agendada
 */
app.delete('/scheduled/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await supabase
            .from('scheduled_messages')
            .update({ status: 'cancelled' })
            .eq('id', id);

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /contacts/:userId - Sincronizar e obter contactos do WhatsApp
 */
app.get('/contacts/:userId', async (req, res) => {
    const { userId } = req.params;
    const session = userSessions.get(userId);

    if (!session || session.status !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    try {
        console.log(`[WA ${userId}] Iniciando sincronização de contactos...`);

        // Obter todos os contactos do WhatsApp
        let contacts;
        try {
            contacts = await session.client.getContacts();
            console.log(`[WA ${userId}] getContacts() retornou ${contacts?.length || 0} contactos`);
        } catch (getContactsErr) {
            console.error(`[WA ${userId}] Erro em getContacts():`, getContactsErr);
            throw new Error(`Erro ao obter contactos do WhatsApp: ${getContactsErr.message}`);
        }

        // Função para normalizar número de telefone (apenas dígitos)
        const normalizeNumber = (num) => {
            if (!num) return null;
            // Remover tudo exceto dígitos
            const cleaned = String(num).replace(/\D/g, '');
            // Verificar se tem pelo menos 7 dígitos (número mínimo válido)
            return cleaned.length >= 7 ? cleaned : null;
        };

        // Função para limpar texto (remover caracteres problemáticos)
        const cleanText = (text) => {
            if (!text) return null;
            // Remover caracteres de controlo e emojis problemáticos, manter texto normal
            return String(text)
                .replace(/[\x00-\x1F\x7F]/g, '') // Remove caracteres de controlo
                .substring(0, 255)
                .trim() || null;
        };

        // Filtrar apenas contactos válidos (com nome e número)
        const validContacts = contacts
            .filter(c => {
                try {
                    if (!c.isMyContact) return false;
                    if (!c.name || typeof c.name !== 'string') return false;
                    const normalized = normalizeNumber(c.number);
                    return normalized !== null;
                } catch (e) {
                    return false;
                }
            })
            .map(c => ({
                name: cleanText(c.name) || 'Sem Nome',
                number: normalizeNumber(c.number),
                pushname: cleanText(c.pushname),
                isGroup: c.isGroup || false
            }))
            .filter(c => c.name && c.number);

        console.log(`[WA ${userId}] Sincronizados ${validContacts.length} contactos`);

        // Guardar/atualizar contactos no Supabase (com tratamento de erros individual)
        let savedCount = 0;
        let errorCount = 0;

        for (const contact of validContacts) {
            try {
                const { error: upsertError } = await supabase
                    .from('whatsapp_contacts')
                    .upsert({
                        user_id: userId,
                        phone_number: contact.number,
                        name: contact.name,
                        pushname: contact.pushname,
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: 'user_id,phone_number'
                    });

                if (upsertError) {
                    console.error(`[WA ${userId}] Erro ao guardar contacto ${contact.name}:`, upsertError.message);
                    errorCount++;
                } else {
                    savedCount++;
                }
            } catch (contactErr) {
                console.error(`[WA ${userId}] Erro inesperado com contacto ${contact.name}:`, contactErr.message);
                errorCount++;
            }
        }

        console.log(`[WA ${userId}] Guardados: ${savedCount}, Erros: ${errorCount}`);

        res.json({
            success: true,
            count: validContacts.length,
            saved: savedCount,
            errors: errorCount,
            contacts: validContacts
        });

    } catch (err) {
        console.error(`[API] Erro ao sincronizar contactos:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// AI AUTO-REPLY ENDPOINTS
// ==========================================

/**
 * POST /ai/enable - Ativar AI auto-reply
 */
app.post('/ai/enable', async (req, res) => {
    const { userId, aiLevel, systemPrompt } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    try {
        // Guardar configurações em memória
        userAISettings.set(userId, {
            enabled: true,
            aiLevel: aiLevel || 2,
            systemPrompt: systemPrompt || null
        });

        // Guardar no Supabase
        await supabase
            .from('profiles')
            .update({
                ai_auto_reply: true,
                ai_level: aiLevel || 2,
                ai_system_prompt: systemPrompt || null
            })
            .eq('id', userId);

        console.log(`[AI] Auto-reply ATIVADO para user ${userId} (level: ${aiLevel || 2})`);

        res.json({
            success: true,
            enabled: true,
            aiLevel: aiLevel || 2,
            message: 'AI auto-reply ativado!'
        });

    } catch (err) {
        console.error(`[API] Erro ao ativar AI:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /ai/disable - Desativar AI auto-reply
 */
app.post('/ai/disable', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    try {
        // Desativar em memória
        const settings = userAISettings.get(userId);
        if (settings) {
            settings.enabled = false;
            userAISettings.set(userId, settings);
        }

        // Atualizar no Supabase
        await supabase
            .from('profiles')
            .update({ ai_auto_reply: false })
            .eq('id', userId);

        console.log(`[AI] Auto-reply DESATIVADO para user ${userId}`);

        res.json({
            success: true,
            enabled: false,
            message: 'AI auto-reply desativado'
        });

    } catch (err) {
        console.error(`[API] Erro ao desativar AI:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /ai/status/:userId - Obter status do AI auto-reply
 */
app.get('/ai/status/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        // Verificar em memória primeiro
        let settings = userAISettings.get(userId);

        // Se não estiver em memória, carregar do Supabase
        if (!settings) {
            settings = await loadUserAISettings(userId);
            if (settings.enabled) {
                userAISettings.set(userId, settings);
            }
        }

        res.json({
            enabled: settings?.enabled || false,
            aiLevel: settings?.aiLevel || 2,
            hasCustomPrompt: !!settings?.systemPrompt
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /ai/prompt - Atualizar system prompt da AI
 */
app.post('/ai/prompt', async (req, res) => {
    const { userId, systemPrompt } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    try {
        // Atualizar em memória
        const settings = userAISettings.get(userId) || { enabled: false, aiLevel: 2 };
        settings.systemPrompt = systemPrompt;
        userAISettings.set(userId, settings);

        // Atualizar no Supabase
        await supabase
            .from('profiles')
            .update({ ai_system_prompt: systemPrompt })
            .eq('id', userId);

        console.log(`[AI] System prompt atualizado para user ${userId}`);

        res.json({
            success: true,
            message: 'System prompt atualizado'
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /ai/history/:userId - Limpar histórico de conversas AI
 */
app.delete('/ai/history/:userId', async (req, res) => {
    const { userId } = req.params;
    const { contactNumber } = req.query;

    try {
        if (contactNumber) {
            // Limpar histórico de um contacto específico
            const cacheKey = `${userId}:${contactNumber}`;
            conversationCache.delete(cacheKey);
            console.log(`[AI] Histórico limpo para ${userId}:${contactNumber}`);
        } else {
            // Limpar todo o histórico do utilizador
            for (const key of conversationCache.keys()) {
                if (key.startsWith(`${userId}:`)) {
                    conversationCache.delete(key);
                }
            }
            console.log(`[AI] Todo o histórico limpo para user ${userId}`);
        }

        res.json({ success: true, message: 'Histórico limpo' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// APPOINTMENTS (Agenda Avançada)
// ==========================================

/**
 * Criar agendamento na agenda avançada
 */
async function createAppointment(userId, appointmentData) {
    try {
        const appointment = {
            user_id: userId,
            date: appointmentData.date, // YYYY-MM-DD
            start_time: appointmentData.start, // HH:MM
            duration: appointmentData.duration || 60,
            client_name: appointmentData.client || 'Cliente WhatsApp',
            client_phone: appointmentData.phone || null,
            type: 'apt-booked',
            notes: appointmentData.notes || 'Agendado via WhatsApp AI',
            source: 'whatsapp_ai',
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('appointments')
            .insert(appointment)
            .select()
            .single();

        if (error) {
            console.error(`[APPT] Error creating appointment:`, error);
            return null;
        }

        console.log(`[APPT] Appointment created for ${userId}: ${appointment.date} ${appointment.start_time}`);
        return data;
    } catch (err) {
        console.error(`[APPT] Error:`, err);
        return null;
    }
}

/**
 * Verificar disponibilidade para uma data/hora
 */
async function checkAvailability(userId, date, startTime, duration = 60) {
    try {
        // Buscar eventos existentes nessa data
        const { data: existingEvents, error } = await supabase
            .from('appointments')
            .select('start_time, duration')
            .eq('user_id', userId)
            .eq('date', date);

        if (error) {
            console.error(`[APPT] Error checking availability:`, error);
            return false;
        }

        // Converter para minutos para comparação
        const parseTime = (timeStr) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        const newStart = parseTime(startTime);
        const newEnd = newStart + duration;

        // Verificar conflitos
        for (const event of (existingEvents || [])) {
            const eventStart = parseTime(event.start_time);
            const eventEnd = eventStart + (event.duration || 60);

            // Verifica sobreposição
            if (newStart < eventEnd && newEnd > eventStart) {
                return false; // Conflito encontrado
            }
        }

        return true; // Disponível
    } catch (err) {
        console.error(`[APPT] Error:`, err);
        return false;
    }
}

/**
 * POST /appointments - Criar agendamento
 */
app.post('/appointments', async (req, res) => {
    const { userId, date, start, duration, client, phone, notes } = req.body;

    if (!userId || !date || !start) {
        return res.status(400).json({ error: 'userId, date e start são obrigatórios' });
    }

    try {
        // Verificar disponibilidade
        const isAvailable = await checkAvailability(userId, date, start, duration || 60);
        if (!isAvailable) {
            return res.status(409).json({
                error: 'Horário não disponível',
                message: 'Já existe um agendamento neste horário'
            });
        }

        const appointment = await createAppointment(userId, {
            date, start, duration, client, phone, notes
        });

        if (!appointment) {
            return res.status(500).json({ error: 'Erro ao criar agendamento' });
        }

        res.json({ success: true, appointment });

    } catch (err) {
        console.error(`[API] Error creating appointment:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /appointments/:userId - Listar agendamentos
 */
app.get('/appointments/:userId', async (req, res) => {
    const { userId } = req.params;
    const { date, startDate, endDate } = req.query;

    try {
        let query = supabase
            .from('appointments')
            .select('*')
            .eq('user_id', userId)
            .order('date', { ascending: true })
            .order('start_time', { ascending: true });

        if (date) {
            query = query.eq('date', date);
        } else if (startDate && endDate) {
            query = query.gte('date', startDate).lte('date', endDate);
        }

        const { data, error } = await query;

        if (error) throw error;

        res.json({ appointments: data || [] });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /appointments/:id - Cancelar agendamento
 */
app.delete('/appointments/:id', async (req, res) => {
    const { id } = req.params;

    try {
        await supabase
            .from('appointments')
            .delete()
            .eq('id', id);

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// PROCESSADOR DE MENSAGENS AGENDADAS
// ==========================================

/**
 * Verifica e envia mensagens agendadas a cada minuto
 */
async function processScheduledMessages() {
    try {
        const now = new Date().toISOString();
        console.log(`[SCHEDULER] A verificar mensagens às ${now}`);

        // Buscar mensagens pendentes cuja hora já passou
        const { data: messages, error } = await supabase
            .from('scheduled_messages')
            .select('*')
            .eq('status', 'pending')
            .lte('scheduled_at', now);

        if (error) {
            console.error('[SCHEDULER] Erro ao buscar mensagens:', error);
            return;
        }

        if (!messages || messages.length === 0) {
            // Log ocasional para confirmar que está a funcionar
            return;
        }

        console.log(`[SCHEDULER] ${messages.length} mensagens para enviar`);

        for (const msg of messages) {
            console.log(`[SCHEDULER] A processar mensagem ${msg.id} para ${msg.to_number} (user: ${msg.user_id})`);

            const session = userSessions.get(msg.user_id);

            if (!session || session.status !== 'connected') {
                // User não conectado, marcar como falhado
                const sessionStatus = session ? session.status : 'sem sessão';
                const activeSessions = Array.from(userSessions.keys());
                console.log(`[SCHEDULER] FALHOU - Sessão não conectada. Status: ${sessionStatus}. Sessões ativas: ${activeSessions.join(', ') || 'nenhuma'}`);

                await supabase
                    .from('scheduled_messages')
                    .update({ status: 'failed', error: `WhatsApp não conectado (${sessionStatus})` })
                    .eq('id', msg.id);
                continue;
            }

            try {
                console.log(`[SCHEDULER] Tentando enviar para: ${msg.to_number}`);

                // Verificar se o número está registado no WhatsApp
                const numberId = await session.client.getNumberId(msg.to_number);
                if (!numberId) {
                    console.log(`[SCHEDULER] Número não encontrado no WhatsApp: ${msg.to_number}`);
                    await supabase
                        .from('scheduled_messages')
                        .update({ status: 'failed', error: 'Número não está no WhatsApp' })
                        .eq('id', msg.id);
                    continue;
                }
                console.log(`[SCHEDULER] Número válido: ${numberId._serialized}`);

                // Enviar mensagem de forma simples
                const chatId = msg.to_number + '@c.us';
                const result = await session.client.sendMessage(chatId, msg.message);
                console.log(`[SCHEDULER] Mensagem enviada! ID: ${result.id._serialized}`)

                // Marcar como enviado
                await supabase
                    .from('scheduled_messages')
                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                    .eq('id', msg.id);

                // Guardar na tabela de mensagens
                await supabase
                    .from('whatsapp_messages')
                    .insert({
                        user_id: msg.user_id,
                        from_number: session.phone,
                        to_number: msg.to_number,
                        body: msg.message,
                        type: 'sent',
                        timestamp: new Date().toISOString()
                    });

                console.log(`[SCHEDULER] Enviado para ${msg.to_number}`);

            } catch (err) {
                await supabase
                    .from('scheduled_messages')
                    .update({ status: 'failed', error: err.message })
                    .eq('id', msg.id);
            }
        }

    } catch (err) {
        console.error(`[SCHEDULER] Erro:`, err);
    }
}

// Correr processador a cada 15 segundos (para agendamentos curtos)
setInterval(processScheduledMessages, 15 * 1000);

// ==========================================
// RESTAURAR SESSÕES NO ARRANQUE
// ==========================================
/**
 * Restaura automaticamente as sessões WhatsApp dos utilizadores
 * que estavam conectados antes do servidor reiniciar
 */
async function restoreConnectedSessions() {
    try {
        console.log('[STARTUP] A verificar sessões para restaurar...');

        // Buscar utilizadores que tinham WhatsApp conectado
        const { data: users, error } = await supabase
            .from('profiles')
            .select('id, whatsapp_phone')
            .eq('whatsapp_status', 'connected');

        if (error) {
            console.error('[STARTUP] Erro ao buscar utilizadores:', error);
            return;
        }

        if (!users || users.length === 0) {
            console.log('[STARTUP] Nenhuma sessão para restaurar');
            return;
        }

        console.log(`[STARTUP] A restaurar ${users.length} sessões...`);

        for (const user of users) {
            try {
                console.log(`[STARTUP] A restaurar sessão do user ${user.id}...`);
                const session = getOrCreateClient(user.id);

                // Inicializar o cliente (vai tentar usar sessão guardada pelo LocalAuth)
                await session.client.initialize();

                // Aguardar um pouco entre cada inicialização para não sobrecarregar
                await new Promise(resolve => setTimeout(resolve, 5000));

            } catch (err) {
                console.error(`[STARTUP] Erro ao restaurar sessão ${user.id}:`, err.message);
                // Marcar como desconectado se falhar
                await supabase
                    .from('profiles')
                    .update({ whatsapp_status: 'disconnected' })
                    .eq('id', user.id);
            }
        }

        console.log('[STARTUP] Restauração de sessões concluída');

    } catch (err) {
        console.error('[STARTUP] Erro geral ao restaurar sessões:', err);
    }
}

// ==========================================
// INICIAR SERVIDOR
// ==========================================
app.listen(PORT, async () => {
    console.log(`
    ========================================
    WhatsApp Server - PromptLab
    ========================================
    Servidor a correr na porta ${PORT}

    Endpoints:
    - GET  /health             - Status do servidor
    - POST /connect            - Iniciar conexão (QR Code)
    - GET  /status/:userId     - Status da conexão
    - POST /disconnect         - Desconectar
    - POST /send               - Enviar mensagem
    - POST /schedule           - Agendar mensagem
    - GET  /scheduled/:userId  - Listar agendadas
    - DELETE /scheduled/:id    - Cancelar agendada
    - GET  /contacts/:userId   - Sincronizar contactos

    AI Auto-Reply:
    - POST /ai/enable          - Ativar AI auto-reply
    - POST /ai/disable         - Desativar AI auto-reply
    - GET  /ai/status/:userId  - Status do AI
    - POST /ai/prompt          - Atualizar system prompt
    - DELETE /ai/history/:userId - Limpar histórico AI
    ========================================
    `);

    // Restaurar sessões dos utilizadores conectados
    await restoreConnectedSessions();

    // Iniciar processador de mensagens agendadas
    processScheduledMessages();
});
// Force redeploy Wed Jan 14 21:49:30 WET 2026
// Forced rebuild Wed Jan 14 22:04:08 WET 2026
// Deploy Tue Jan 20 00:37:07 WET 2026
