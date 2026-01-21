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
const KNOWLEDGE_CACHE_TTL = 60 * 1000; // 1 minuto - refresh mais frequente para disponibilidades

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
 * Buscar horários de trabalho/disponibilidade do utilizador
 * Agora suporta horários por dia da semana (Agenda Avançada) e buffer time
 */
async function getUserBusinessHours(userId) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('availability_hour_open, availability_hour_close, business_hour_open, business_hour_close, hours_per_day, working_days, buffer_time')
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`[AI] Error fetching business hours:`, error);
            return { open: 9, close: 18, hoursPerDay: null, workingDays: null, bufferTime: 15 }; // Default
        }

        // Priorizar availability_hour, senão usar business_hour (fallback global)
        const open = data.availability_hour_open ?? data.business_hour_open ?? 9;
        const close = data.availability_hour_close ?? data.business_hour_close ?? 18;

        // Horários por dia da Agenda Avançada (pode ser null se não configurado)
        const hoursPerDay = data.hours_per_day || null;
        const workingDays = data.working_days || null;

        // Buffer time entre agendamentos (default 15 min)
        const bufferTime = data.buffer_time ?? 15;

        console.log(`[AI] User ${userId} hours: global=${open}-${close}, perDay=${hoursPerDay ? 'configured' : 'not set'}, workingDays=${workingDays ? JSON.stringify(workingDays) : 'all'}, bufferTime=${bufferTime}min`);

        return { open, close, hoursPerDay, workingDays, bufferTime };
    } catch (err) {
        console.error(`[AI] Error fetching business hours:`, err);
        return { open: 9, close: 18, hoursPerDay: null, workingDays: null, bufferTime: 15 };
    }
}

/**
 * Buscar agendamentos existentes do utilizador
 */
async function getUserAppointments(userId) {
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
            console.error(`[AI] Error fetching appointments:`, error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error(`[AI] Error fetching appointments:`, err);
        return [];
    }
}

/**
 * Buscar serviços configurados pelo utilizador
 * Os serviços são guardados em localStorage no frontend, mas sincronizados com profiles
 */
async function getUserServices(userId) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('services')
            .eq('id', userId)
            .single();

        if (error || !data || !data.services) {
            // Retornar serviços padrão se não houver configurados
            return [
                { id: 1, name: 'Corte de Cabelo', duration: 30, price: 15, color: '#7c4dff' },
                { id: 2, name: 'Barba', duration: 20, price: 10, color: '#29b6f6' },
                { id: 3, name: 'Corte + Barba', duration: 45, price: 22, color: '#66bb6a' },
                { id: 4, name: 'Coloração', duration: 60, price: 35, color: '#ff9800' },
                { id: 5, name: 'Tratamento Capilar', duration: 45, price: 25, color: '#e91e63' }
            ];
        }

        return data.services;
    } catch (err) {
        console.error(`[AI] Error fetching services:`, err);
        return [];
    }
}

/**
 * Calcular slots de disponibilidade com granularidade de 10 MINUTOS
 *
 * LÓGICA:
 * - Slots de 10 em 10 minutos (00, 10, 20, 30, 40, 50)
 * - Mais natural para clientes (evita horários estranhos como :05, :25, :35)
 * - Disponível = dentro do horário de funcionamento do dia específico E sem appointments marcados
 * - Usa horários por dia se configurados (Agenda Avançada), senão usa horário global
 * - Respeita os dias de trabalho configurados (working_days)
 * - Considera duração exata dos appointments
 * - Aplica buffer time entre agendamentos
 *
 * @param {string} userId - ID do utilizador
 * @param {Object} businessHours - { open, close, hoursPerDay, workingDays, bufferTime }
 * @param {Array} appointments - Lista de appointments já obtidos
 */
async function getUserAvailableSlots(userId, businessHours, appointments = []) {
    try {
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const { open, close, hoursPerDay, workingDays, bufferTime = 15 } = businessHours;

        // Granularidade de 10 minutos (horários mais naturais: :00, :10, :20, :30, :40, :50)
        const SLOT_GRANULARITY = 10;

        // Gerar lista de datas para os próximos 7 dias
        const dates = [];
        for (let d = new Date(now); d <= weekFromNow; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const dayOfWeek = d.getDay(); // 0=Sunday, 1=Monday, etc.
            dates.push({ date: dateStr, dayOfWeek });
        }

        console.log(`[AI] Calculating 10-min availability for user ${userId}, dates: ${dates.map(d => d.date).join(', ')}`);
        console.log(`[AI] Using per-day hours: ${hoursPerDay ? 'YES' : 'NO (global)'}, working days: ${workingDays ? JSON.stringify(workingDays) : 'all'}, bufferTime: ${bufferTime}min`);

        // Criar mapa de slots de 10 minutos ocupados: { "2026-01-20:14:30": true }
        const occupiedSlots = {};
        (appointments || []).forEach(apt => {
            if (!apt.date || !apt.start_time) return;

            // Extrair hora e minuto do start_time (formato "HH:MM" ou "HH:MM:SS")
            const [startHour, startMinute] = apt.start_time.split(':').map(Number);
            const startInMinutes = startHour * 60 + (startMinute || 0);
            const duration = apt.duration || 60; // default 60 minutos

            // Duração total = duração do serviço + buffer time
            const totalBlockedTime = duration + bufferTime;

            // Marcar todos os slots de 10 min ocupados pelo appointment + buffer
            for (let m = 0; m < totalBlockedTime; m += SLOT_GRANULARITY) {
                const slotMinutes = startInMinutes + m;
                const hour = Math.floor(slotMinutes / 60);
                const minute = slotMinutes % 60;
                const key = `${apt.date}:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                occupiedSlots[key] = true;
            }
        });

        console.log(`[AI] Occupied 10-min slots from appointments (with ${bufferTime}min buffer): ${Object.keys(occupiedSlots).length}`);

        // Gerar todos os slots disponíveis de 10 em 10 minutos
        const availableSlots = [];
        const currentTime = now.getTime();

        dates.forEach(({ date, dayOfWeek }) => {
            // Verificar se é um dia de trabalho
            if (workingDays && !workingDays.includes(dayOfWeek)) {
                return; // Pular este dia
            }

            // Obter horário específico do dia ou usar global
            let dayOpen = open;
            let dayClose = close;

            if (hoursPerDay && hoursPerDay[dayOfWeek]) {
                dayOpen = hoursPerDay[dayOfWeek].open;
                dayClose = hoursPerDay[dayOfWeek].close;
            }

            // Gerar slots de 10 em 10 minutos para este dia
            for (let hour = dayOpen; hour < dayClose; hour++) {
                for (let minute = 0; minute < 60; minute += SLOT_GRANULARITY) {
                    const key = `${date}:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                    // Verificar se o slot já passou (para o dia atual)
                    const slotTime = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
                    if (slotTime < currentTime) {
                        continue; // Slot já passou
                    }

                    // Disponível se não está ocupado por um appointment
                    if (!occupiedSlots[key]) {
                        availableSlots.push({
                            date,
                            hour,
                            minute,
                            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
                            dayOfWeek,
                            available: true
                        });
                    }
                }
            }
        });

        console.log(`[AI] Found ${availableSlots.length} available 10-min slots`);
        return availableSlots;
    } catch (err) {
        console.error(`[AI] Error calculating availability slots:`, err);
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

    // Buscar businessHours, posts, appointments e services em paralelo
    const [businessHours, posts, appointments, services] = await Promise.all([
        getUserBusinessHours(userId),
        getUserFeedPosts(userId),
        getUserAppointments(userId),
        getUserServices(userId)
    ]);

    // Calcular slots disponíveis baseado nos appointments (espaços livres) - agora com 5 min
    const availableSlots = await getUserAvailableSlots(userId, businessHours, appointments);

    const knowledge = {
        posts,
        appointments,
        availableSlots,
        businessHours,
        services,
        lastUpdated: now
    };

    userKnowledgeCache.set(userId, knowledge);
    console.log(`[AI] Knowledge cache updated for user ${userId}: ${posts.length} posts, ${appointments.length} appointments, ${availableSlots.length} 10-min slots, ${services.length} services`);

    // Debug: mostrar alguns slots disponíveis
    if (availableSlots.length > 0) {
        const sampleSlots = availableSlots.slice(0, 10);
        console.log(`[AI] Sample available slots for ${userId}:`, sampleSlots.map(s => `${s.date} ${s.time}`).join(', '));
    } else {
        console.log(`[AI] WARNING: No available slots found for user ${userId}`);
    }

    return knowledge;
}

/**
 * Formatar conhecimento para incluir no contexto da AI
 * Linguagem simples e amigável (sem termos técnicos)
 *
 * IMPORTANTE: Só mostra intervalos com pelo menos 30 minutos disponíveis
 * (intervalos pequenos não servem para nenhum serviço)
 */
function formatKnowledgeContext(knowledge) {
    let context = '';

    // Duração mínima útil = 30 min (serviço mais curto geralmente é 20-30 min)
    const MIN_USEFUL_INTERVAL = 30;

    // Formatar SERVIÇOS disponíveis
    if (knowledge.services && knowledge.services.length > 0) {
        context += `\n\n=== SERVIÇOS ===\n`;
        context += `Pergunte qual serviço o cliente quer. Preços só se perguntarem.\n\n`;
        knowledge.services.forEach(service => {
            context += `• ${service.name} (${service.duration} min) - ${service.price}€\n`;
        });
    }

    // Formatar horários de trabalho/disponibilidade
    if (knowledge.businessHours) {
        const { open, close } = knowledge.businessHours;
        context += `\n\n=== HORÁRIO ===\n`;
        context += `Atendemos das ${open}h às ${close}h.\n`;
    }

    // Formatar posts do feed
    if (knowledge.posts && knowledge.posts.length > 0) {
        context += '\n\n=== INFO DO NEGÓCIO ===\n';
        knowledge.posts.forEach((post) => {
            context += `• ${post.title}`;
            if (post.summary) {
                context += `: ${post.summary}`;
            }
            context += '\n';
        });
    }

    // Função auxiliar para formatar hora
    const formatTime = (timeStr) => {
        return timeStr.replace(':00', 'h').replace(':30', 'h30').replace(':10', 'h10').replace(':20', 'h20').replace(':40', 'h40').replace(':50', 'h50');
    };

    // Calcular duração de um intervalo em minutos
    const getIntervalDuration = (startTime, endTime) => {
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        return (eh * 60 + em) - (sh * 60 + sm) + 10; // +10 porque o último slot também conta
    };

    // Formatar horários DISPONÍVEIS - só intervalos úteis (>=30 min)
    if (knowledge.availableSlots && knowledge.availableSlots.length > 0) {
        context += '\n\n=== HORÁRIOS DISPONÍVEIS ===\n';
        context += 'Só pode agendar nestes horários. Se o cliente pedir um que não está na lista, diga que está ocupado e sugira alternativas.\n\n';

        // Agrupar por data
        const byDate = {};
        knowledge.availableSlots.forEach(slot => {
            if (!byDate[slot.date]) byDate[slot.date] = [];
            byDate[slot.date].push(slot.time);
        });

        // Mostrar de forma simples - só intervalos >= 30 min
        Object.keys(byDate).sort().forEach(date => {
            if (byDate[date].length > 0) {
                const dateObj = new Date(date);
                const dateStr = dateObj.toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
                const times = byDate[date].sort();

                // Agrupar em intervalos contínuos
                const rawIntervals = [];
                let intervalStart = times[0];
                let lastTime = times[0];

                for (let i = 1; i < times.length; i++) {
                    const [h, m] = times[i].split(':').map(Number);
                    const [lh, lm] = lastTime.split(':').map(Number);
                    const diff = (h * 60 + m) - (lh * 60 + lm);

                    if (diff > 10) {
                        // Intervalo quebrou - guardar o anterior
                        rawIntervals.push({ start: intervalStart, end: lastTime });
                        intervalStart = times[i];
                    }
                    lastTime = times[i];
                }
                rawIntervals.push({ start: intervalStart, end: lastTime });

                // Filtrar apenas intervalos com pelo menos 30 minutos
                const usefulIntervals = rawIntervals.filter(interval => {
                    const duration = getIntervalDuration(interval.start, interval.end);
                    return duration >= MIN_USEFUL_INTERVAL;
                });

                // Se há intervalos úteis, mostrar
                if (usefulIntervals.length > 0) {
                    const formattedIntervals = usefulIntervals.map(interval =>
                        `${formatTime(interval.start)}-${formatTime(interval.end)}`
                    );
                    context += `• ${dateStr}: ${formattedIntervals.join(', ')}\n`;
                }
            }
        });
    } else {
        context += '\n\n=== DISPONIBILIDADE ===\n';
        context += 'Não há horários disponíveis de momento. Peça ao cliente para tentar mais tarde.\n';
    }

    return context;
}

/**
 * Chamar a AI para gerar resposta
 */
async function getAIResponse(userId, contactNumber, userMessage, contactName = 'Cliente') {
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

        // Construir system prompt personalizado - AMIGÁVEL E DESCONTRAÍDO
        const defaultPrompt = `Você é um assistente simpático e descontraído que responde mensagens WhatsApp em nome do utilizador.

ESTILO DE COMUNICAÇÃO:
- Seja amigável, caloroso e use emojis de forma natural 😊
- Respostas curtas e diretas, como numa conversa normal de WhatsApp
- Use linguagem casual e acolhedora
- Responda no mesmo idioma da mensagem recebida
- Não use formatação markdown - apenas texto simples
- Exemplos de tom: "Olá! 👋", "Claro que sim! 😊", "Perfeito! ✨", "Boa escolha! 💈"

FLUXO DE AGENDAMENTO:
1. Pergunte qual serviço o cliente deseja de forma simpática
2. Após saber o serviço, sugira 2-3 horários disponíveis de forma clara e simples
3. Confirme o agendamento de forma calorosa

PREÇOS: Só informe se o cliente perguntar diretamente.

Para criar um agendamento, responda com o formato especial no FINAL:
[AGENDAR: YYYY-MM-DD HH:MM duração_minutos "Nome do Cliente" "Serviço: nome do serviço"]

Exemplo:
"Ótimo! Fica marcado o teu Corte de Cabelo para dia 20 às 14h! 💈✨
[AGENDAR: 2026-01-20 14:00 30 "João Silva" "Serviço: Corte de Cabelo"]"

IMPORTANTE: A duração DEVE ser a duração do serviço escolhido.`;

        // Instruções de agendamento - SEMPRE incluídas (mais simples e amigáveis)
        const appointmentInstructions = `

CLIENTE ATUAL: ${contactName} (${contactNumber})

COMO AGENDAR:
1. Pergunte qual serviço deseja (se ainda não souber)
2. Sugira 2-3 horários disponíveis de forma simples (ex: "Tenho disponível às 10h, 14h ou 16h 😊")
3. Quando o cliente escolher, confirme com carinho

FORMATO para criar agendamento (no FINAL da mensagem):
[AGENDAR: YYYY-MM-DD HH:MM duração "Nome" "Serviço: nome"]

IMPORTANTE:
- Use o nome "${contactName}" no agendamento
- A duração = duração do serviço escolhido
- Horários disponíveis: :00, :10, :20, :30, :40, :50

Exemplo:
"Perfeito ${contactName}! 😊 Fica marcado o teu Corte para dia 20 às 14h! 💈✨
[AGENDAR: 2026-01-20 14:00 30 "${contactName}" "Serviço: Corte de Cabelo"]"

O formato [AGENDAR: ...] é OBRIGATÓRIO para criar o agendamento.`;

        // Se tem prompt personalizado, usa-o + instruções de agendamento
        // Se não tem, usa o default (que já inclui instruções)
        let systemPrompt = settings.systemPrompt
            ? settings.systemPrompt + appointmentInstructions
            : defaultPrompt;

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

        console.log(`[AI] Calling AI for user ${userId}, contact ${contactNumber} (knowledge: ${knowledge.posts.length} posts, ${knowledge.appointments.length} appointments, ${knowledge.availableSlots.length} available slots)`);

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

        // Obter nome do contacto do WhatsApp
        let contactName = 'Cliente';
        try {
            const contact = await message.getContact();
            if (contact) {
                contactName = contact.pushname || contact.name || contact.shortName || 'Cliente';
            }
        } catch (e) {
            console.log(`[WA ${userId}] Não foi possível obter nome do contacto`);
        }

        console.log(`[WA ${userId}] Mensagem recebida de ${contactName} (${contactNumber}): ${message.body}`);

        // Guardar mensagem no Supabase
        await saveIncomingMessage(userId, message);

        // === AI AUTO-REPLY ===
        // Verificar se AI auto-reply está ativo para este utilizador
        const settings = userAISettings.get(userId);
        if (settings && settings.enabled && message.body && message.body.trim()) {
            console.log(`[AI ${userId}] AI auto-reply ativo, a processar mensagem...`);

            try {
                // Obter resposta da AI (passa nome do contacto)
                const aiReply = await getAIResponse(userId, contactNumber, message.body, contactName);

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

/**
 * POST /knowledge/invalidate - Invalidar cache de conhecimento do utilizador
 * Chamado quando o utilizador muda configurações importantes como default_availability
 */
app.post('/knowledge/invalidate', (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId é obrigatório' });
    }

    try {
        // Limpar cache de conhecimento (posts, agenda, disponibilidade)
        const hadCache = userKnowledgeCache.has(userId);
        userKnowledgeCache.delete(userId);

        console.log(`[CACHE] Knowledge cache invalidated for user ${userId} (had cache: ${hadCache})`);

        res.json({
            success: true,
            message: hadCache ? 'Cache invalidado' : 'Utilizador não tinha cache ativo'
        });

    } catch (err) {
        console.error(`[CACHE] Error invalidating cache:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// APPOINTMENTS (Agenda Avançada)
// ==========================================

/**
 * Criar agendamento na agenda avançada
 * Inclui informação do serviço nas notas
 */
async function createAppointment(userId, appointmentData) {
    try {
        // Extrair nome do serviço das notas se presente
        let serviceName = null;
        if (appointmentData.notes && appointmentData.notes.includes('Serviço:')) {
            const match = appointmentData.notes.match(/Serviço:\s*([^"]+)/);
            if (match) {
                serviceName = match[1].trim();
            }
        }

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
            service_name: serviceName, // Nome do serviço
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

        console.log(`[APPT] Appointment created for ${userId}: ${appointment.date} ${appointment.start_time} - Service: ${serviceName || 'N/A'}`);
        return data;
    } catch (err) {
        console.error(`[APPT] Error:`, err);
        return null;
    }
}

/**
 * Verificar disponibilidade para uma data/hora com granularidade de 5 minutos
 * Verifica se há espaço suficiente para a duração do serviço
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
            return h * 60 + (m || 0);
        };

        const newStart = parseTime(startTime);
        const newEnd = newStart + duration;

        console.log(`[APPT] Checking availability: ${date} ${startTime} for ${duration} min (${newStart}-${newEnd})`);

        // Verificar conflitos com precisão de 5 minutos
        for (const event of (existingEvents || [])) {
            const eventStart = parseTime(event.start_time);
            const eventEnd = eventStart + (event.duration || 60);

            // Verifica sobreposição (qualquer sobreposição, mesmo parcial)
            if (newStart < eventEnd && newEnd > eventStart) {
                console.log(`[APPT] Conflict found: existing ${event.start_time} (${eventStart}-${eventEnd}) overlaps with new (${newStart}-${newEnd})`);
                return false; // Conflito encontrado
            }
        }

        // Verificar também os horários de funcionamento
        const businessHours = await getUserBusinessHours(userId);
        const dateObj = new Date(date);
        const dayOfWeek = dateObj.getDay();

        let dayOpen = businessHours.open;
        let dayClose = businessHours.close;

        if (businessHours.hoursPerDay && businessHours.hoursPerDay[dayOfWeek]) {
            dayOpen = businessHours.hoursPerDay[dayOfWeek].open;
            dayClose = businessHours.hoursPerDay[dayOfWeek].close;
        }

        const openMinutes = dayOpen * 60;
        const closeMinutes = dayClose * 60;

        // Verificar se está dentro do horário de funcionamento
        if (newStart < openMinutes || newEnd > closeMinutes) {
            console.log(`[APPT] Outside business hours: ${newStart}-${newEnd} not within ${openMinutes}-${closeMinutes}`);
            return false;
        }

        // Verificar se é um dia de trabalho
        if (businessHours.workingDays && !businessHours.workingDays.includes(dayOfWeek)) {
            console.log(`[APPT] Not a working day: ${dayOfWeek}`);
            return false;
        }

        console.log(`[APPT] Slot available: ${date} ${startTime} for ${duration} min`);
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
    - POST /knowledge/invalidate - Invalidar cache de conhecimento
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
// Deploy Mon Jan 20 07:00:00 WET 2026 - AI only books on AVAILABLE slots, stricter instructions
// Deploy Tue Jan 20 07:28:04 WET 2026
