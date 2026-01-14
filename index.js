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
        console.log(`[WA ${userId}] Mensagem recebida de ${message.from}: ${message.body}`);

        // Guardar mensagem no Supabase
        await saveIncomingMessage(userId, message);
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
// PROCESSADOR DE MENSAGENS AGENDADAS
// ==========================================

/**
 * Verifica e envia mensagens agendadas a cada minuto
 */
async function processScheduledMessages() {
    try {
        const now = new Date().toISOString();

        // Buscar mensagens pendentes cuja hora já passou
        const { data: messages, error } = await supabase
            .from('scheduled_messages')
            .select('*')
            .eq('status', 'pending')
            .lte('scheduled_at', now);

        if (error || !messages || messages.length === 0) return;

        console.log(`[SCHEDULER] ${messages.length} mensagens para enviar`);

        for (const msg of messages) {
            const session = userSessions.get(msg.user_id);

            if (!session || session.status !== 'connected') {
                // User não conectado, marcar como falhado
                await supabase
                    .from('scheduled_messages')
                    .update({ status: 'failed', error: 'WhatsApp não conectado' })
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
// INICIAR SERVIDOR
// ==========================================
app.listen(PORT, () => {
    console.log(`
    ========================================
    WhatsApp Server - PromptLab
    ========================================
    Servidor a correr na porta ${PORT}

    Endpoints:
    - GET  /health          - Status do servidor
    - POST /connect         - Iniciar conexão (QR Code)
    - GET  /status/:userId  - Status da conexão
    - POST /disconnect      - Desconectar
    - POST /send            - Enviar mensagem
    - POST /schedule        - Agendar mensagem
    - GET  /scheduled/:userId - Listar agendadas
    - DELETE /scheduled/:id - Cancelar agendada
    ========================================
    `);

    // Iniciar processador de mensagens agendadas
    processScheduledMessages();
});
// Force redeploy Wed Jan 14 21:49:30 WET 2026
// Forced rebuild Wed Jan 14 22:04:08 WET 2026
