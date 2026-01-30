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

// Google Calendar API URL
const CALENDAR_API_URL = 'https://calendario-production-003b.up.railway.app';

// Tenant Helper para queries por schema
const { TenantHelper } = require('./tenant-helper');
const tenant = new TenantHelper(supabase);

// Scheduling Engine - PARTILHADO com a app para consistência
const { SchedulingEngine } = require('./scheduling-engine-server');

// Cache de engines por userId
const schedulingEngineCache = new Map();
const SCHEDULING_ENGINE_CACHE_TTL = 60 * 1000; // 1 minuto

/**
 * Obter ou criar SchedulingEngine para um userId
 * Usa cache para evitar reinicializar constantemente
 */
async function getOrCreateSchedulingEngine(userId, forceRefresh = false) {
    const cached = schedulingEngineCache.get(userId);
    const now = Date.now();

    // Se cache válido e não forçar refresh, retornar
    if (cached && !forceRefresh && (now - cached.timestamp) < SCHEDULING_ENGINE_CACHE_TTL) {
        return cached.engine;
    }

    // Se cache existe mas expirou, fazer refresh
    if (cached && (now - cached.timestamp) >= SCHEDULING_ENGINE_CACHE_TTL) {
        try {
            await cached.engine.refresh();
            cached.timestamp = now;
            return cached.engine;
        } catch (err) {
            console.error(`[SCHEDULING] Error refreshing engine for ${userId}:`, err.message);
        }
    }

    // Criar novo engine
    console.log(`[SCHEDULING] Creating new engine for user ${userId}`);
    const engine = new SchedulingEngine(supabase);
    await engine.initialize(userId);

    schedulingEngineCache.set(userId, {
        engine,
        timestamp: now
    });

    return engine;
}

// Inicializar Express
const app = express();

// CORS explícito para permitir todas as origens
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false
}));

// Também responder a OPTIONS manualmente (preflight)
app.options('*', cors());

app.use(express.json());

// ==========================================
// ARMAZENAMENTO DE SESSÕES (por user)
// ==========================================
const userSessions = new Map(); // userId -> { client, qrCode, status, lastActivity, reconnectAttempts }

// ==========================================
// SISTEMA DE AUTO-RECONEXÃO (HEARTBEAT) - v2.0
// ==========================================
const HEARTBEAT_INTERVAL = 60 * 1000; // Verificar a cada 60 segundos
const INACTIVITY_THRESHOLD = 3 * 60 * 1000; // 3 minutos sem atividade = possível problema
const STUCK_AUTH_THRESHOLD = 2 * 60 * 1000; // 2 minutos em "authenticated" sem ir para "connected" = preso
const MAX_RECONNECT_ATTEMPTS = 3; // Máximo de tentativas de reconexão antes de desistir
const RECONNECT_COOLDOWN = 5 * 60 * 1000; // 5 minutos entre ciclos de tentativas (evita loop infinito)
const FAILED_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutos - depois de falhar, espera antes de tentar de novo

// Contador GLOBAL de tentativas (persiste entre sessões)
const reconnectTracker = new Map(); // userId -> { attempts, lastAttemptTime, failedAt }

/**
 * Obter ou criar tracker de reconexão para um user
 */
function getReconnectTracker(userId) {
    if (!reconnectTracker.has(userId)) {
        reconnectTracker.set(userId, {
            attempts: 0,
            lastAttemptTime: 0,
            failedAt: null
        });
    }
    return reconnectTracker.get(userId);
}

/**
 * Resetar tracker de reconexão (quando conexão tem sucesso)
 */
function resetReconnectTracker(userId) {
    reconnectTracker.set(userId, {
        attempts: 0,
        lastAttemptTime: 0,
        failedAt: null
    });
    console.log(`[HEARTBEAT] Tracker resetado para ${userId}`);
}

/**
 * Atualizar timestamp de última atividade para uma sessão
 */
function updateSessionActivity(userId) {
    const session = userSessions.get(userId);
    if (session) {
        session.lastActivity = Date.now();
        // Reset tracker quando há atividade real (mensagem recebida)
        resetReconnectTracker(userId);
    }
}

/**
 * Forçar reconexão de uma sessão
 */
async function forceReconnect(userId) {
    const session = userSessions.get(userId);
    const tracker = getReconnectTracker(userId);
    const now = Date.now();

    // Verificar se já falhou e está em período de espera
    if (tracker.failedAt && (now - tracker.failedAt) < FAILED_SESSION_TIMEOUT) {
        const waitMinutes = Math.round((FAILED_SESSION_TIMEOUT - (now - tracker.failedAt)) / 60000);
        console.log(`[HEARTBEAT] Sessão ${userId} em período de espera após falha (${waitMinutes}min restantes)`);
        return false;
    }

    // Verificar cooldown entre tentativas
    if (tracker.lastAttemptTime && (now - tracker.lastAttemptTime) < RECONNECT_COOLDOWN) {
        console.log(`[HEARTBEAT] Sessão ${userId} em cooldown, aguardando...`);
        return false;
    }

    // Incrementar contador GLOBAL de tentativas
    tracker.attempts++;
    tracker.lastAttemptTime = now;

    console.log(`[HEARTBEAT] Forçando reconexão para user ${userId} (tentativa ${tracker.attempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    // Verificar se atingiu máximo de tentativas
    if (tracker.attempts > MAX_RECONNECT_ATTEMPTS) {
        console.log(`[HEARTBEAT] ❌ Máximo de tentativas atingido para ${userId}. Sessão marcada como falhada.`);
        console.log(`[HEARTBEAT] ❌ Requer scan de QR code manual. Próxima tentativa automática em 30 minutos.`);
        tracker.failedAt = now;
        tracker.attempts = 0; // Reset para próximo ciclo

        // Limpar sessão corrompida
        if (session) {
            try {
                if (session.client) await session.client.destroy();
            } catch (e) { /* ignore */ }
            userSessions.delete(userId);
        }
        return false;
    }

    try {
        // Tentar destruir cliente antigo
        if (session && session.client) {
            try {
                await session.client.destroy();
            } catch (e) {
                console.log(`[HEARTBEAT] Aviso ao destruir cliente: ${e.message}`);
            }
        }

        // Remover sessão antiga
        userSessions.delete(userId);

        // Matar processos Chrome órfãos que possam estar a bloquear
        try {
            const { exec } = require('child_process');
            exec(`pkill -f "chromium.*${userId}" || true`);
        } catch (e) { /* ignore */ }

        // Aguardar um pouco mais (dar tempo ao sistema)
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Criar nova sessão
        const newSession = getOrCreateClient(userId);
        await newSession.client.initialize();

        console.log(`[HEARTBEAT] ✓ Reconexão iniciada para ${userId} (tentativa ${tracker.attempts})`);
        return true;

    } catch (err) {
        console.error(`[HEARTBEAT] Erro ao reconectar ${userId}:`, err.message);
        return false;
    }
}

/**
 * Verificar saúde das sessões (heartbeat)
 */
async function checkSessionsHealth() {
    const now = Date.now();

    for (const [userId, session] of userSessions) {
        const lastActivity = session.lastActivity || session.createdAt || now;
        const timeSinceActivity = now - lastActivity;
        const tracker = getReconnectTracker(userId);

        // Verificar se está em período de falha (não tentar nada)
        if (tracker.failedAt && (now - tracker.failedAt) < FAILED_SESSION_TIMEOUT) {
            continue; // Skip esta sessão
        }

        // =====================================================
        // CASO 1: Sessão presa em "authenticated" (não chegou a "connected")
        // =====================================================
        if (session.status === 'authenticated') {
            if (timeSinceActivity > STUCK_AUTH_THRESHOLD) {
                console.log(`[HEARTBEAT] Sessão ${userId} presa em 'authenticated' há ${Math.round(timeSinceActivity / 1000)}s`);
                await forceReconnect(userId);
            }
            continue;
        }

        // =====================================================
        // CASO 2: Sessão "connected" mas possivelmente zombie
        // =====================================================
        if (session.status !== 'connected') continue;

        // Verificar estado real da conexão
        try {
            const state = await session.client.getState();

            if (state === 'CONNECTED') {
                // Está conectado de verdade - resetar tracker se tinha tentativas
                if (tracker.attempts > 0) {
                    console.log(`[HEARTBEAT] ✓ Sessão ${userId} recuperou! Resetando tracker.`);
                    resetReconnectTracker(userId);
                }

                // Log periódico se estava inativo
                if (timeSinceActivity > INACTIVITY_THRESHOLD) {
                    console.log(`[HEARTBEAT] Sessão ${userId} OK (state: ${state}, inativo: ${Math.round(timeSinceActivity / 1000)}s)`);
                    session.lastActivity = now;
                }
            } else {
                // Estado não é CONNECTED, tentar reconectar
                console.log(`[HEARTBEAT] Sessão ${userId} em estado ${state}, tentando reconectar...`);
                await forceReconnect(userId);
            }
        } catch (stateErr) {
            // Erro ao verificar estado = provavelmente desconectado
            console.log(`[HEARTBEAT] Erro ao verificar ${userId}: ${stateErr.message}`);
            await forceReconnect(userId);
        }
    }
}

// Iniciar heartbeat quando servidor arranca
let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    heartbeatInterval = setInterval(checkSessionsHealth, HEARTBEAT_INTERVAL);
    console.log(`[HEARTBEAT] Sistema de auto-reconexão v2.0 iniciado (intervalo: ${HEARTBEAT_INTERVAL / 1000}s)`);
}

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
const KNOWLEDGE_CACHE_TTL = 30 * 1000; // 30 segundos - refresh frequente para disponibilidades actuais

/**
 * Buscar artigos da knowledge base do utilizador
 * Cada tenant tem o seu próprio schema com a tabela knowledge_base
 */
async function getUserFeedPosts(userId) {
    try {
        const kb = await tenant.knowledgeBase(userId);
        const { data, error } = await kb
            .select('title, summary, content')
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`[AI] Error fetching knowledge base:`, error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error(`[AI] Error fetching knowledge base:`, err);
        return [];
    }
}

/**
 * Buscar horários de trabalho/disponibilidade do utilizador
 * Suporta horários por dia da semana (Agenda Avançada)
 */
async function getUserBusinessHours(userId) {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('availability_hour_open, availability_hour_close, business_hour_open, business_hour_close, hours_per_day, working_days')
            .eq('id', userId)
            .single();

        if (error) {
            console.error(`[AI] Error fetching business hours:`, error);
            return { open: 9, close: 18, hoursPerDay: null, workingDays: null };
        }

        const open = data.availability_hour_open ?? data.business_hour_open ?? 9;
        const close = data.availability_hour_close ?? data.business_hour_close ?? 18;
        const hoursPerDay = data.hours_per_day || null;
        const workingDays = data.working_days || null;

        console.log(`[AI] User ${userId} hours: global=${open}-${close}, perDay=${hoursPerDay ? 'configured' : 'not set'}, workingDays=${workingDays ? JSON.stringify(workingDays) : 'all'}`);

        return { open, close, hoursPerDay, workingDays };
    } catch (err) {
        console.error(`[AI] Error fetching business hours:`, err);
        return { open: 9, close: 18, hoursPerDay: null, workingDays: null };
    }
}

/**
 * Buscar agendamentos existentes do utilizador
 * CORRIGIDO: Usa schema público (igual ao frontend advanced-agenda.js)
 */
async function getUserAppointments(userId) {
    try {
        // Buscar eventos da agenda (próximos 7 dias)
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // IMPORTANTE: Usar schema público, igual ao frontend
        const { data, error } = await supabase
            .from('appointments')
            .select('id, client_name, date, start_time, duration, type, notes')
            .eq('user_id', userId)
            .gte('date', now.toISOString().split('T')[0])
            .lte('date', weekFromNow.toISOString().split('T')[0])
            .order('date', { ascending: true })
            .order('start_time', { ascending: true });

        if (error) {
            console.error(`[AI] Error fetching appointments:`, error);
            return [];
        }

        console.log(`[AI] Found ${(data || []).length} appointments in DB for user ${userId}`);
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
            // Retornar array vazio se não houver serviços configurados
            return [];
        }

        return data.services;
    } catch (err) {
        console.error(`[AI] Error fetching services:`, err);
        return [];
    }
}

/**
 * Buscar produtos do utilizador da tabela products
 */
async function getUserProducts(userId) {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('name, description, price, active')
            .eq('user_id', userId)
            .eq('active', true)
            .order('created_at', { ascending: false });

        if (error) {
            console.error(`[AI] Error fetching products:`, error);
            return [];
        }

        console.log(`[AI] Fetched ${data?.length || 0} products for user ${userId}`);
        return data || [];
    } catch (err) {
        console.error(`[AI] Error fetching products:`, err);
        return [];
    }
}

/**
 * Calcular slots de disponibilidade com granularidade de 10 MINUTOS
 * VERSÃO CORRIGIDA v4.1 - Considera duração mínima do serviço
 *
 * LÓGICA:
 * - Slots de 10 em 10 minutos (00, 10, 20, 30, 40, 50)
 * - Disponível = dentro do horário de funcionamento E cabe um serviço sem conflito
 * - Usa horários por dia se configurados (Agenda Avançada)
 * - Respeita os dias de trabalho configurados (working_days)
 *
 * @param {string} userId - ID do utilizador
 * @param {Object} businessHours - { open, close, hoursPerDay, workingDays }
 * @param {Array} appointments - Lista de appointments já obtidos
 * @param {number} minServiceDuration - Duração mínima do serviço (para calcular se cabe)
 */
async function getUserAvailableSlots(userId, businessHours, appointments = [], minServiceDuration = 20) {
    try {
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const { open, close, hoursPerDay, workingDays } = businessHours;

        const SLOT_GRANULARITY = 10;

        const dates = [];
        for (let d = new Date(now); d <= weekFromNow; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const dayOfWeek = d.getDay();
            dates.push({ date: dateStr, dayOfWeek });
        }

        console.log(`[AI] Calculating availability for user ${userId} (min duration: ${minServiceDuration}min)`);

        // Criar lista de blocos ocupados por data (com início e fim)
        const occupiedRanges = {};

        (appointments || []).forEach(apt => {
            if (!apt.date || !apt.start_time) return;

            const [startHour, startMinute] = apt.start_time.split(':').map(Number);
            const startInMinutes = startHour * 60 + (startMinute || 0);
            const duration = apt.duration || 60;
            const endInMinutes = startInMinutes + duration;

            if (!occupiedRanges[apt.date]) occupiedRanges[apt.date] = [];
            occupiedRanges[apt.date].push({
                start: startInMinutes,
                end: endInMinutes
            });
        });

        // Ordenar ranges por início
        Object.keys(occupiedRanges).forEach(date => {
            occupiedRanges[date].sort((a, b) => a.start - b.start);
        });

        // Função para verificar se um slot com duração X cabe sem conflito
        const canFitService = (date, startMins, serviceDuration, dayCloseMins) => {
            const endMins = startMins + serviceDuration;

            // Verificar se excede hora de fecho
            if (endMins > dayCloseMins) {
                return false;
            }

            // Verificar conflitos com appointments existentes
            const ranges = occupiedRanges[date] || [];
            for (const range of ranges) {
                // Conflito se: newStart < range.end E newEnd > range.start
                if (startMins < range.end && endMins > range.start) {
                    return false;
                }
            }

            return true;
        };

        // Gerar slots disponíveis
        const availableSlots = [];
        const currentTime = now.getTime();

        dates.forEach(({ date, dayOfWeek }) => {
            // Verificar se é um dia de trabalho
            if (workingDays && !workingDays.includes(dayOfWeek)) {
                return;
            }

            // Obter horário específico do dia ou usar global
            let dayOpen = open;
            let dayClose = close;

            if (hoursPerDay && hoursPerDay[dayOfWeek]) {
                dayOpen = hoursPerDay[dayOfWeek].open;
                dayClose = hoursPerDay[dayOfWeek].close;
            }

            const dayOpenMins = dayOpen * 60;
            const dayCloseMins = dayClose * 60;

            // Gerar slots de 10 em 10 minutos
            for (let mins = dayOpenMins; mins < dayCloseMins; mins += SLOT_GRANULARITY) {
                const hour = Math.floor(mins / 60);
                const minute = mins % 60;

                // Verificar se o slot já passou (para o dia atual)
                const slotTime = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
                if (slotTime < currentTime) {
                    continue;
                }

                // Verificar se CABE um serviço de duração mínima neste slot
                if (canFitService(date, mins, minServiceDuration, dayCloseMins)) {
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
        });

        console.log(`[AI] Found ${availableSlots.length} available slots (for ${minServiceDuration}min service)`);

        // DEBUG: Mostrar resumo de slots por data
        const slotsByDate = {};
        availableSlots.forEach(s => {
            if (!slotsByDate[s.date]) slotsByDate[s.date] = [];
            slotsByDate[s.date].push(s.time);
        });
        Object.keys(slotsByDate).sort().forEach(date => {
            const slots = slotsByDate[date];
            const first = slots[0];
            const last = slots[slots.length - 1];
            console.log(`[AI]   ${date}: ${slots.length} slots (${first} - ${last})`);
        });

        return availableSlots;
    } catch (err) {
        console.error(`[AI] Error calculating availability slots:`, err);
        return [];
    }
}

/**
 * Buscar TODOS os eventos do Google Calendar para os próximos 7 dias
 */
async function getGoogleCalendarEventsForWeek(userId) {
    try {
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const response = await fetch(
            `${CALENDAR_API_URL}/events/${userId}?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(weekFromNow.toISOString())}`
        );

        if (!response.ok) {
            console.log(`[GCAL] User ${userId} not connected to Google Calendar`);
            return [];
        }

        const data = await response.json();
        const events = data.events || [];

        // Converter para formato de appointment
        const convertedEvents = [];
        events.forEach(event => {
            // Ignorar eventos de dia inteiro
            if (event.allDay) return;

            const startDate = new Date(event.start);
            const endDate = event.end ? new Date(event.end) : null;

            if (isNaN(startDate.getTime())) return;

            const date = startDate.toISOString().split('T')[0];
            const startTime = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;

            let duration = 60;
            if (endDate && !isNaN(endDate.getTime())) {
                duration = Math.round((endDate - startDate) / (1000 * 60));
                if (duration <= 0) duration = 60;
            }

            convertedEvents.push({
                date,
                start_time: startTime,
                duration,
                client_name: event.summary || 'Google Calendar',
                type: 'gcal-event',
                notes: 'Evento do Google Calendar'
            });
        });

        console.log(`[GCAL] Converted ${convertedEvents.length} Google Calendar events for AI context`);
        return convertedEvents;
    } catch (err) {
        console.log(`[GCAL] Error fetching Google Calendar events for week:`, err.message);
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

    // Buscar businessHours, posts, appointments, services, products E eventos Google Calendar em paralelo
    const [businessHours, posts, dbAppointments, services, products, googleEvents] = await Promise.all([
        getUserBusinessHours(userId),
        getUserFeedPosts(userId),
        getUserAppointments(userId),
        getUserServices(userId),
        getUserProducts(userId),
        getGoogleCalendarEventsForWeek(userId)
    ]);

    // COMBINAR appointments da DB com eventos do Google Calendar
    // Isto garante que TODOS os eventos são considerados como ocupados
    const allAppointments = [...dbAppointments];

    // Adicionar eventos do Google Calendar (evitando duplicados por data+hora)
    googleEvents.forEach(gEvent => {
        const exists = allAppointments.some(
            apt => apt.date === gEvent.date && apt.start_time === gEvent.start_time
        );
        if (!exists) {
            allAppointments.push(gEvent);
        }
    });

    console.log(`[AI] Total events for availability: ${allAppointments.length} (${dbAppointments.length} DB + ${googleEvents.length} Google)`);

    // DEBUG DETALHADO: Mostrar appointments encontrados
    if (allAppointments.length > 0) {
        console.log(`[AI] ====== APPOINTMENTS DETECTADOS ======`);
        allAppointments.forEach(apt => {
            const startMins = apt.start_time ? parseInt(apt.start_time.split(':')[0]) * 60 + parseInt(apt.start_time.split(':')[1] || 0) : 0;
            const endMins = startMins + (apt.duration || 60);
            const endTime = `${Math.floor(endMins / 60).toString().padStart(2, '0')}:${(endMins % 60).toString().padStart(2, '0')}`;
            console.log(`[AI]   📅 ${apt.date} | ${apt.start_time}-${endTime} (${apt.duration || 60}min) | ${apt.client_name || apt.type || 'N/A'}`);
        });
        console.log(`[AI] =====================================`);
    } else {
        console.log(`[AI] ⚠️ WARNING: No appointments found for user ${userId}`);
    }

    // Calcular duração mínima dos serviços
    let minServiceDuration = 20;
    if (services && services.length > 0) {
        const durations = services.map(s => s.duration || 60).filter(d => d > 0);
        if (durations.length > 0) {
            minServiceDuration = Math.min(...durations);
        }
    }
    console.log(`[AI] Min service duration for ${userId}: ${minServiceDuration}min`);

    // Calcular slots disponíveis usando TODOS os appointments (DB + Google Calendar)
    const availableSlots = await getUserAvailableSlots(userId, businessHours, allAppointments, minServiceDuration);

    const knowledge = {
        posts,
        appointments: allAppointments, // TODOS os eventos (DB + Google Calendar)
        availableSlots,
        businessHours,
        services,
        products,
        lastUpdated: now
    };

    userKnowledgeCache.set(userId, knowledge);
    console.log(`[AI] Knowledge cache updated for user ${userId}: ${posts.length} posts, ${allAppointments.length} appointments (${dbAppointments.length} DB + ${googleEvents.length} Google), ${availableSlots.length} slots, ${services.length} services`);

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
 * Formatar conhecimento para incluir no contexto da AI v4.0
 * Formato optimizado e claro para melhor compreensão do AI
 */
function formatKnowledgeContext(knowledge) {
    let context = '';

    // Duração mínima útil = 20 min (serviço mais curto)
    const MIN_USEFUL_INTERVAL = 20;
    const SLOT_GRANULARITY = 10;

    // Funções auxiliares
    const formatTime = (timeStr) => {
        if (!timeStr) return '';
        const [h, m] = timeStr.split(':');
        return m === '00' ? `${parseInt(h)}h` : `${parseInt(h)}h${m}`;
    };

    const timeToMinutes = (timeStr) => {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + (m || 0);
    };

    const minutesToTime = (minutes) => {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // Data de hoje
    const hoje = new Date();
    const hojeStr = hoje.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
    context += `\n\n📆 HOJE: ${hojeStr}\n`;

    // Formatar SERVIÇOS disponíveis
    if (knowledge.services && knowledge.services.length > 0) {
        context += `\n🛠️ SERVIÇOS:\n`;
        knowledge.services.forEach(service => {
            const price = service.price ? ` - ${service.price}€` : '';
            context += `• ${service.name} (${service.duration} min)${price}\n`;
        });
    }

    // Formatar PRODUTOS disponíveis
    if (knowledge.products && knowledge.products.length > 0) {
        context += `\n🏷️ PRODUTOS:\n`;
        knowledge.products.forEach(product => {
            const price = product.price ? `${product.price.toFixed(2)}€` : 'Preço sob consulta';
            context += `• ${product.name} - ${price}\n`;
        });
    }

    // Horário de funcionamento
    if (knowledge.businessHours) {
        const { open, close, workingDays } = knowledge.businessHours;
        context += `\n⏰ HORÁRIO: ${open}h às ${close}h\n`;

        // Dias fechados
        if (workingDays && workingDays.length < 7) {
            const dayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
            const closedDays = dayNames.filter((_, i) => !workingDays.includes(i));
            if (closedDays.length > 0) {
                context += `🚷 FECHADO: ${closedDays.join(', ')}\n`;
            }
        }
    }

    // Formatar posts do feed
    if (knowledge.posts && knowledge.posts.length > 0) {
        context += '\n📋 INFO DO NEGÓCIO:\n';
        knowledge.posts.slice(0, 5).forEach((post) => {
            context += `• ${post.title}`;
            if (post.summary) {
                context += `: ${post.summary}`;
            }
            context += '\n';
        });
    }

    // Processar appointments ocupados
    const occupiedByDate = {};
    if (knowledge.appointments && knowledge.appointments.length > 0) {
        knowledge.appointments.forEach(apt => {
            if (!apt.date || !apt.start_time) return;
            if (!occupiedByDate[apt.date]) occupiedByDate[apt.date] = [];

            const duration = apt.duration || 60;
            const startMinutes = timeToMinutes(apt.start_time);
            const endMinutes = startMinutes + duration;

            occupiedByDate[apt.date].push({
                start: apt.start_time.substring(0, 5),
                end: minutesToTime(endMinutes),
                startMinutes,
                endMinutes,
                client: apt.client_name || 'Ocupado',
                type: apt.type
            });
        });
    }

    // HORÁRIOS OCUPADOS - CRÍTICO
    if (Object.keys(occupiedByDate).length > 0) {
        context += '\n🚫 HORÁRIOS OCUPADOS (NÃO AGENDAR!):\n';

        Object.keys(occupiedByDate).sort().forEach(date => {
            const dateObj = new Date(date + 'T12:00:00');
            const dateLabel = getDateLabel(dateObj);
            const slots = occupiedByDate[date].sort((a, b) => a.startMinutes - b.startMinutes);

            const formatted = slots.map(s => `${formatTime(s.start)}-${formatTime(s.end)}`).join(', ');
            context += `• ${dateLabel}: ${formatted}\n`;
        });
    }

    // HORÁRIOS DISPONÍVEIS
    if (knowledge.availableSlots && knowledge.availableSlots.length > 0) {
        context += '\n✅ HORÁRIOS DISPONÍVEIS:\n';

        // Agrupar por data
        const byDate = {};
        knowledge.availableSlots.forEach(slot => {
            if (!byDate[slot.date]) byDate[slot.date] = [];
            byDate[slot.date].push(slot.time);
        });

        // Calcular janelas contínuas
        Object.keys(byDate).sort().forEach(date => {
            const times = byDate[date].sort();
            if (times.length === 0) return;

            const dateObj = new Date(date + 'T12:00:00');
            const dateLabel = getDateLabel(dateObj);

            // Agrupar em janelas contínuas
            const windows = [];
            let winStart = times[0];
            let lastTime = times[0];

            for (let i = 1; i < times.length; i++) {
                const currMins = timeToMinutes(times[i]);
                const lastMins = timeToMinutes(lastTime);

                if (currMins - lastMins > SLOT_GRANULARITY) {
                    // Gap encontrado - fechar janela
                    windows.push({ start: winStart, end: lastTime });
                    winStart = times[i];
                }
                lastTime = times[i];
            }
            windows.push({ start: winStart, end: lastTime });

            // Filtrar janelas úteis e formatar
            const usefulWindows = windows.filter(w => {
                const duration = timeToMinutes(w.end) - timeToMinutes(w.start) + SLOT_GRANULARITY;
                return duration >= MIN_USEFUL_INTERVAL;
            });

            if (usefulWindows.length > 0) {
                const formatted = usefulWindows.map(w =>
                    `${formatTime(w.start)}-${formatTime(minutesToTime(timeToMinutes(w.end) + 30))}`
                ).join(', ');
                context += `• ${dateLabel}: ${formatted}\n`;
            } else {
                context += `• ${dateLabel}: poucos slots (pergunte horário específico)\n`;
            }
        });
    } else {
        context += '\n⚠️ Sem horários disponíveis nos próximos dias.\n';
    }

    return context;
}

/**
 * Formata data para label natural em português
 */
function getDateLabel(dateObj) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateOnly = new Date(dateObj);
    dateOnly.setHours(0, 0, 0, 0);

    if (dateOnly.getTime() === today.getTime()) {
        return 'hoje';
    } else if (dateOnly.getTime() === tomorrow.getTime()) {
        return 'amanhã';
    } else {
        const diffDays = Math.ceil((dateOnly - today) / (1000 * 60 * 60 * 24));
        if (diffDays <= 5) {
            return dateObj.toLocaleDateString('pt-PT', { weekday: 'long' });
        }
        return dateObj.toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short' });
    }
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

        // =====================================================
        // CONSTRUIR SYSTEM PROMPT A PARTIR DO AI STUDIO
        // =====================================================

        // Função para combinar os segmentos do AI Studio num único prompt
        const buildPromptFromSegments = (aiPrompts) => {
            if (!aiPrompts) return null;

            let prompt = 'És um assistente que responde mensagens WhatsApp em nome do utilizador.\n\n';

            // Personalidade
            if (aiPrompts.personality) {
                prompt += `PERSONALIDADE:\n${aiPrompts.personality}\n\n`;
            }

            // Idioma & Expressões
            if (aiPrompts.language) {
                prompt += `IDIOMA E EXPRESSÕES:\n${aiPrompts.language}\n\n`;
            }

            // Saudação
            if (aiPrompts.greeting) {
                prompt += `SAUDAÇÃO INICIAL:\n${aiPrompts.greeting}\n\n`;
            }

            // Informação do Negócio
            if (aiPrompts.business) {
                prompt += `SOBRE O NEGÓCIO:\n${aiPrompts.business}\n\n`;
            }

            // Regras de Resposta
            if (aiPrompts.rules) {
                prompt += `REGRAS DE RESPOSTA:\n${aiPrompts.rules}\n\n`;
            }

            // Instruções Especiais
            if (aiPrompts.custom) {
                prompt += `INSTRUÇÕES ESPECIAIS:\n${aiPrompts.custom}\n\n`;
            }

            return prompt.trim();
        };

        // Prompt padrão (fallback se não houver AI Studio configurado)
        const defaultPrompt = `És um assistente profissional que responde mensagens WhatsApp em nome de uma empresa. O teu objetivo é perceber o que o contacto precisa e agendar uma chamada telefónica com a equipa.

=== PERSONALIDADE ===
- Simpático, prestável e genuinamente interessado em ajudar
- Tom conversacional e natural (não robótico nem formal demais)
- Usas 1-2 emojis por mensagem, com moderação
- Português de Portugal (PT-PT): usa "tu", "fixe", "está bem" - evita "você"

=== FLUXO DE CONVERSA ===

PASSO 1 - ACOLHER:
Se é primeira mensagem, cumprimentar e perguntar como podes ajudar.
Exemplo: "Olá! 😊 Em que posso ajudar-te?"

PASSO 2 - PERCEBER A NECESSIDADE:
Faz perguntas para entender o que a pessoa precisa:
- "O que procuras exatamente?"
- "Podes contar-me mais sobre a tua situação?"
- "É para uso pessoal ou para uma empresa?"
- "Tens alguma urgência ou prazo em mente?"

PASSO 3 - VALIDAR E PROPOR CHAMADA:
Quando perceberes a necessidade, valida e propõe a chamada:
"Entendi! Para [resumo da necessidade], o melhor é agendar uma chamada para te dar todas as informações. Qual o melhor horário para ti?"

=== COMO LIDAR COM SITUAÇÕES ===

SE PERGUNTAM PREÇOS:
"Os valores dependem de vários fatores. Para te dar um orçamento certinho, o melhor é agendar uma chamada rápida. Posso agendar?"

SE NÃO QUEREM CHAMADA:
"Sem problema! Diz-me então o que precisas saber e tento ajudar-te por aqui 😊"
(Continua a conversa por mensagem e tenta perceber se há outra forma de ajudar)

SE PEDEM INFO ESPECÍFICA QUE NÃO TENS:
Dá uma resposta útil mas breve, depois redireciona:
"Boa pergunta! Para te dar essa informação em detalhe, uma chamada rápida seria o ideal - assim fica tudo esclarecido. Posso agendar?"

SE É RECLAMAÇÃO/PROBLEMA:
"Lamento que tenhas tido esse problema 😔 Quero ajudar-te a resolver isto - posso agendar uma chamada para tratar do assunto?"

SE PARECER SPAM OU MENSAGEM SEM SENTIDO:
Resposta mínima e educada: "Olá! Em que posso ajudar-te?"

SE A PESSOA É RUDE OU AGRESSIVA:
Mantém a calma e profissionalismo: "Compreendo a tua frustração. Estou aqui para ajudar - diz-me o que precisas."

=== EXEMPLOS DE BOAS CONVERSAS ===

EXEMPLO 1 - Lead interessado:
Cliente: "Olá, queria saber mais sobre os vossos serviços"
Tu: "Olá! 😊 Claro, fico feliz em ajudar. O que procuras especificamente?"
Cliente: "Preciso de ajuda com marketing digital para a minha loja"
Tu: "Boa! E a loja é online, física, ou ambas?"
Cliente: "É uma loja online de roupa"
Tu: "Entendi! Para e-commerce de moda temos várias soluções. O melhor é agendar uma chamada para perceber os teus objetivos e dar-te uma proposta à medida. Preferes de manhã ou à tarde?"
Cliente: "À tarde é melhor"
Tu: "Perfeito! Tenho disponível às 14h, 15h30 ou 17h. Qual preferes?"

EXEMPLO 2 - Pessoa que recusa chamada:
Cliente: "Não tenho disponibilidade para chamadas agora"
Tu: "Sem problema! Diz-me então as tuas dúvidas e ajudo-te por aqui 😊"
Cliente: "Quero saber se fazem websites"
Tu: "Sim, fazemos! Desde sites simples até lojas online completas. Tens algum projeto em mente?"

EXEMPLO 3 - Pergunta sobre preços:
Cliente: "Quanto custa?"
Tu: "Depende do que precisas - temos várias opções para diferentes necessidades. Para te dar um valor certinho, precisava de perceber melhor a tua situação. Tens 10 minutinhos para uma chamada rápida?"

EXEMPLO 4 - Reclamação:
Cliente: "Estou muito insatisfeito com o serviço!"
Tu: "Lamento muito ouvir isso 😔 Quero perceber o que aconteceu e ajudar-te a resolver. Posso agendar uma chamada para tratar disto?"

=== REGRAS IMPORTANTES ===
- Respostas curtas e naturais (máximo 2-3 frases por mensagem)
- NUNCA uses formatação markdown (asteriscos, hashtags, blocos de código)
- Não sejas insistente - se recusarem chamada 2 vezes, não insistas mais
- Foca-te em AJUDAR primeiro, agendar depois
- Cada mensagem deve fazer a conversa avançar
- Usa o nome da pessoa quando souberes (torna a conversa mais pessoal)
- Nunca inventes informações - se não sabes, diz que vais confirmar na chamada`;

        // Instruções de agendamento - SEMPRE incluídas (fixas no servidor)
        const appointmentInstructions = `

=== 📅 SISTEMA DE AGENDAMENTOS ===

CLIENTE ATUAL: ${contactName} (${contactNumber})

⚠️ REGRA CRÍTICA - FORMATAÇÃO:
- NUNCA uses asteriscos (**texto**) ou markdown
- Escreve texto normal sem formatação especial

🔴 FLUXO OBRIGATÓRIO (SEGUIR SEMPRE ESTA ORDEM!):

PASSO 1 - PRIMEIRO PERGUNTA O SERVIÇO:
Se há lista de SERVIÇOS no contexto, SEMPRE pergunta primeiro qual serviço o cliente quer!
Exemplo: "Qual serviço pretendes? Tenho Plano A (20min), Plano B (40min) ou Plano C (60min) 😊"
→ NÃO fales de horários disponíveis antes de saber o serviço!
→ Cada serviço tem duração diferente, o que afeta quais horários cabem!

PASSO 2 - DEPOIS DE SABER O SERVIÇO, VERIFICA DISPONIBILIDADE:
Agora que sabes a duração do serviço escolhido:
- Verifica lista "HORÁRIOS OCUPADOS" → estes NÃO estão disponíveis
- Verifica lista "HORÁRIOS DISPONÍVEIS" → sugere APENAS destes
- IMPORTANTE: Um serviço de 40min precisa de 40min seguidos livres!

PASSO 3 - SUGERE HORÁRIOS PARA O SERVIÇO ESCOLHIDO:
"Para o [serviço], tenho disponível: [horários]"
→ Se cliente pedir horário ocupado: "Esse já está ocupado. Posso às [alternativa mais próxima]?"

PASSO 4 - CONFIRMA ANTES DE CRIAR:
Antes de usar [AGENDAR:], confirma com o cliente:
"Confirmo: [serviço] no [dia] às [hora]. Pode ser?"
→ SÓ cria após confirmação ("sim", "pode ser", "marca")

FORMATO DO COMANDO (colocar no FINAL da mensagem):
[AGENDAR: YYYY-MM-DD HH:MM duração "${contactName}" "Nome do Serviço"]

REGRAS:
- Duração: SEMPRE usa a duração do serviço escolhido pelo cliente
- Horários válidos: :00, :10, :20, :30, :40, :50
- SÓ usa [AGENDAR:] após confirmação explícita do cliente

FORMATO DE DATAS (escolhe apenas UMA forma):
- Hoje → "hoje"
- Amanhã → "amanhã"
- Até 5 dias → dia da semana ("domingo")
- Mais de 5 dias → "dia X de mês"

EXEMPLO DE CONVERSA CORRETA:
---
Cliente: "Quero marcar para domingo"
Tu: "Claro! Qual serviço pretendes? Tenho Plano A (20min), Plano B (40min) ou Plano C (60min) 😊"
Cliente: "Plano B"
Tu: "Para o Plano B (40min), no domingo tenho: 10h, 14h ou 16h40. Qual preferes?"
Cliente: "16h40"
Tu: "Perfeito! Fica marcado Plano B para domingo às 16h40 😊
[AGENDAR: 2026-02-01 16:40 40 "${contactName}" "Plano B"]"
---

EXEMPLO ERRADO (NÃO FAZER):
---
Cliente: "Quero marcar para domingo"
Tu: "Domingo às 18h está disponível!" ← ERRO! Não perguntou o serviço primeiro!
---`;

        // Construir o prompt final
        // Prioridade: 1) AI Studio (aiPrompts), 2) prompt antigo (systemPrompt), 3) default
        let systemPrompt;

        if (settings.aiPrompts && Object.keys(settings.aiPrompts).some(k => settings.aiPrompts[k])) {
            // Usar prompts do AI Studio
            systemPrompt = buildPromptFromSegments(settings.aiPrompts);
            console.log('[AI] Using AI Studio prompts');
        } else if (settings.systemPrompt) {
            // Fallback para o prompt antigo (campo ai_system_prompt)
            systemPrompt = settings.systemPrompt;
            console.log('[AI] Using legacy system prompt');
        } else {
            // Usar prompt padrão
            systemPrompt = defaultPrompt;
            console.log('[AI] Using default prompt');
        }

        // Sempre adicionar instruções de agendamento
        systemPrompt += appointmentInstructions;

        // Sempre adicionar a data atual ao prompt (mesmo com prompt personalizado)
        const hoje = new Date();
        const dataInfo = `\n\nINFORMAÇÃO TEMPORAL IMPORTANTE:
- Data de hoje: ${hoje.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
- Dia da semana: ${hoje.toLocaleDateString('pt-PT', { weekday: 'long' })}
- Amanhã será: ${new Date(hoje.getTime() + 24*60*60*1000).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
        systemPrompt += dataInfo;

        // SEMPRE invalidar cache quando conversa é sobre agendamentos
        // Lista expandida de keywords que indicam contexto de agendamento
        const availabilityKeywords = [
            // Disponibilidade
            'disponível', 'disponivel', 'livre', 'vaga', 'vagas',
            // Horários
            'horário', 'horario', 'hora', 'horas', 'às', 'as ',
            // Ações
            'marcar', 'agendar', 'reservar', 'booking', 'marcação',
            // Tempo
            'hoje', 'amanhã', 'amanha', 'domingo', 'segunda', 'terça', 'terca',
            'quarta', 'quinta', 'sexta', 'sábado', 'sabado', 'semana',
            // Serviços/Planos
            'plano', 'serviço', 'servico', 'tratamento', 'sessão', 'sessao',
            // Confirmações
            'pode ser', 'sim', 'confirmo', 'quero', 'prefiro', 'escolho',
            // Números de hora
            '10h', '11h', '12h', '13h', '14h', '15h', '16h', '17h', '18h', '19h', '20h',
            ':00', ':10', ':20', ':30', ':40', ':50'
        ];
        const asksAboutAvailability = availabilityKeywords.some(kw =>
            userMessage.toLowerCase().includes(kw.toLowerCase())
        );

        // Invalidar cache para ter dados SEMPRE frescos em contexto de agendamento
        if (asksAboutAvailability) {
            console.log(`[AI] Appointment context detected - invalidating cache for fresh data`);
            userKnowledgeCache.delete(userId);
            schedulingEngineCache.delete(userId); // Também invalidar engine cache
        }

        // =====================================================
        // CONTEXTO PARTILHADO COM A APP (SchedulingEngine)
        // =====================================================
        // Usar o SchedulingEngine para gerar contexto IDENTICO à app
        const engine = await getOrCreateSchedulingEngine(userId, asksAboutAvailability);
        const schedulingContext = engine.generateAIContext();

        // Buscar posts do feed (não incluídos no SchedulingEngine)
        const posts = await getUserFeedPosts(userId);
        let postsContext = '';
        if (posts && posts.length > 0) {
            postsContext = '\n📋 INFO DO NEGÓCIO:\n';
            posts.slice(0, 5).forEach(post => {
                postsContext += `• ${post.title}`;
                if (post.summary) postsContext += `: ${post.summary}`;
                postsContext += '\n';
            });
        }

        // Combinar contextos: system prompt + scheduling (partilhado) + posts
        const fullContext = systemPrompt + schedulingContext + postsContext;

        console.log(`[AI] Calling AI for user ${userId}, contact ${contactNumber} (using shared SchedulingEngine, ${posts.length} posts)`);

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
                // Horário não disponível - Procurar alternativas inteligentes
                console.log(`[AI] Time slot not available: ${date} ${time}`);

                // Buscar slots alternativos
                const alternatives = await findAlternativeSlots(userId, date, time, parseInt(duration));

                // Formatar a hora para exibição (ex: 16:30 -> 16h30)
                const formattedTime = time.replace(':', 'h');
                const formattedDate = formatDateForDisplay(date);

                // Construir mensagem com sugestões inteligentes
                let suggestionParts = [];

                // Prioridade 1: Sugestões do mesmo dia
                if (alternatives.sameDayBefore || alternatives.sameDayAfter) {
                    const sameDaySuggestions = [];
                    if (alternatives.sameDayBefore) {
                        sameDaySuggestions.push(alternatives.sameDayBefore.time.replace(':', 'h'));
                    }
                    if (alternatives.sameDayAfter) {
                        sameDaySuggestions.push(alternatives.sameDayAfter.time.replace(':', 'h'));
                    }

                    if (sameDaySuggestions.length === 1) {
                        suggestionParts.push(`Mas tenho disponível às ${sameDaySuggestions[0]} ${formattedDate}! 😊`);
                    } else {
                        suggestionParts.push(`Mas tenho disponível às ${sameDaySuggestions.join(' ou às ')} ${formattedDate}! 😊`);
                    }
                }

                // Prioridade 2: Se não há no mesmo dia, sugerir próximo dia
                if (!alternatives.sameDayBefore && !alternatives.sameDayAfter) {
                    const nextDaySuggestions = [];

                    if (alternatives.nextDayFirstHour) {
                        const nextDayFormatted = formatDateForDisplay(alternatives.nextDayFirstHour.date);
                        const timeFormatted = alternatives.nextDayFirstHour.time.replace(':', 'h');
                        nextDaySuggestions.push(`${timeFormatted} ${nextDayFormatted}`);
                    }

                    if (alternatives.nextDayRequestedTime &&
                        (!alternatives.nextDayFirstHour ||
                         alternatives.nextDayRequestedTime.time !== alternatives.nextDayFirstHour.time)) {
                        const nextDayFormatted = formatDateForDisplay(alternatives.nextDayRequestedTime.date);
                        const timeFormatted = alternatives.nextDayRequestedTime.time.replace(':', 'h');
                        nextDaySuggestions.push(`${timeFormatted} ${nextDayFormatted}`);
                    }

                    if (nextDaySuggestions.length > 0) {
                        suggestionParts.push(`Infelizmente ${formattedDate} está sem vagas. Mas tenho disponível às ${nextDaySuggestions.join(' ou às ')}! 😊`);
                    } else {
                        suggestionParts.push(`Por favor, pergunta-me quais horários tenho livres! 😊`);
                    }
                }

                // Substituir TODA a resposta para evitar confusão
                if (suggestionParts.length > 0) {
                    aiReply = `Peço desculpa, mas o horário das ${formattedTime} de ${formattedDate} já não está disponível. 😔\n\n${suggestionParts.join('\n\n')}\n\nQual preferes?`;
                } else {
                    aiReply = `Peço desculpa, mas o horário das ${formattedTime} de ${formattedDate} já não está disponível. 😔\n\nPor favor, escolhe outro horário dos que te sugeri anteriormente, ou pergunta-me quais horários tenho livres! 😊`;
                }
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
            .select('ai_auto_reply, ai_level, ai_system_prompt, ai_prompts')
            .eq('id', userId)
            .single();

        if (error || !data) {
            return { enabled: false, aiLevel: 2, systemPrompt: null, aiPrompts: null };
        }

        return {
            enabled: data.ai_auto_reply || false,
            aiLevel: data.ai_level || 2,
            systemPrompt: data.ai_system_prompt || null,
            aiPrompts: data.ai_prompts || null // Prompts segmentados do AI Studio
        };
    } catch (err) {
        console.error(`[AI] Error loading settings:`, err);
        return { enabled: false, aiLevel: 2, systemPrompt: null, aiPrompts: null };
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
        status: 'disconnected', // disconnected, qr_ready, authenticated, connected
        phone: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        reconnectAttempts: 0
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
        puppeteer: puppeteerConfig,
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/AltinGrilla/AltinGrilla/refs/heads/main/AltinG.json'
        }
    });

    // Evento: QR Code gerado
    client.on('qr', async (qr) => {
        console.log(`[WA ${userId}] QR Code gerado`);
        session.qrCode = await qrcode.toDataURL(qr);
        session.status = 'qr_ready';
    });

    // Evento: Loading screen (útil para debug)
    client.on('loading_screen', (percent, message) => {
        console.log(`[WA ${userId}] Loading: ${percent}% - ${message}`);
    });

    // Evento: Falha na autenticação
    client.on('auth_failure', (msg) => {
        console.error(`[WA ${userId}] ❌ Falha de autenticação:`, msg);
        session.status = 'auth_failed';
    });

    // Evento: Autenticado com sucesso
    client.on('authenticated', () => {
        console.log(`[WA ${userId}] Autenticado!`);
        session.status = 'authenticated';
        session.lastActivity = Date.now(); // Iniciar timer para detectar se fica preso
    });

    // Evento: Pronto para usar
    client.on('ready', async () => {
        console.log(`[WA ${userId}] Pronto!`);
        session.status = 'connected';
        session.qrCode = null;
        session.lastActivity = Date.now(); // Inicializar timestamp de atividade
        session.reconnectAttempts = 0; // Reset tentativas de reconexão

        // IMPORTANTE: Reset tracker global de reconexão (conexão bem sucedida!)
        resetReconnectTracker(userId);

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

        // Atualizar atividade da sessão (heartbeat)
        updateSessionActivity(userId);

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
        const scheduled = await tenant.scheduledMessages(userId);
        const { data, error } = await scheduled
            .insert({
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
        const scheduled = await tenant.scheduledMessages(userId);
        const { data, error } = await scheduled
            .select('*')
            .eq('status', 'pending')
            .order('scheduled_at', { ascending: true });

        if (error) throw error;

        res.json({ scheduled: data });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /scheduled/:userId/:id - Cancelar mensagem agendada
 */
app.delete('/scheduled/:userId/:id', async (req, res) => {
    const { userId, id } = req.params;

    try {
        const scheduled = await tenant.scheduledMessages(userId);
        await scheduled
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

        const contactsTable = await tenant.whatsappContacts(userId);
        for (const contact of validContacts) {
            try {
                const { error: upsertError } = await contactsTable
                    .upsert({
                        phone_number: contact.number,
                        name: contact.name,
                        pushname: contact.pushname,
                        updated_at: new Date().toISOString()
                    }, {
                        onConflict: 'phone_number'
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

        // CORRIGIDO: Usar schema público (igual ao frontend)
        const { data, error } = await supabase
            .from('appointments')
            .insert(appointment)
            .select()
            .single();

        if (error) {
            console.error(`[APPT] Error creating appointment:`, error);
            return null;
        }

        console.log(`[APPT] Appointment created in PUBLIC schema for ${userId}: ${appointment.date} ${appointment.start_time} - Service: ${serviceName || 'N/A'}`);
        return data;
    } catch (err) {
        console.error(`[APPT] Error:`, err);
        return null;
    }
}

/**
 * Buscar eventos do Google Calendar para um userId e data específica
 */
async function getGoogleCalendarEvents(userId, date) {
    try {
        // Criar timeMin e timeMax para o dia específico
        const dateObj = new Date(date);
        const timeMin = new Date(dateObj.setHours(0, 0, 0, 0)).toISOString();
        const timeMax = new Date(dateObj.setHours(23, 59, 59, 999)).toISOString();

        const response = await fetch(
            `${CALENDAR_API_URL}/events/${userId}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
        );

        if (!response.ok) {
            console.log(`[GCAL] User ${userId} not connected to Google Calendar or error fetching`);
            return [];
        }

        const data = await response.json();
        console.log(`[GCAL] Found ${data.events?.length || 0} Google Calendar events for ${date}`);
        return data.events || [];
    } catch (err) {
        console.log(`[GCAL] Error fetching Google Calendar events:`, err.message);
        return [];
    }
}

/**
 * Verificar disponibilidade para uma data/hora com granularidade de 5 minutos
 * Verifica se há espaço suficiente para a duração do serviço
 * Inclui verificação de eventos do Google Calendar
 */
async function checkAvailability(userId, date, startTime, duration = 60) {
    try {
        // Buscar TODOS os eventos nessa data (appointments + bloqueios)
        // CORRIGIDO: Usar schema público (igual ao frontend)
        const { data: existingEvents, error } = await supabase
            .from('appointments')
            .select('start_time, duration, type, client_name')
            .eq('user_id', userId)
            .eq('date', date);

        if (error) {
            console.error(`[APPT] Error checking availability:`, error);
            return false;
        }

        // Buscar eventos do Google Calendar
        const googleEvents = await getGoogleCalendarEvents(userId, date);

        // Log de todos os eventos encontrados
        console.log(`[APPT] Found ${(existingEvents || []).length} appointments on ${date}:`,
            (existingEvents || []).map(e => `${e.start_time} (${e.type || 'apt'}: ${e.client_name})`).join(', '));
        if (googleEvents.length > 0) {
            console.log(`[APPT] Found ${googleEvents.length} Google Calendar events on ${date}:`,
                googleEvents.map(e => `${e.title} (${e.start} - ${e.end})`).join(', '));
        }

        // Converter para minutos para comparação
        const parseTime = (timeStr) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + (m || 0);
        };

        const newStart = parseTime(startTime);
        const newEnd = newStart + duration;

        console.log(`[APPT] Checking availability: ${date} ${startTime} for ${duration} min (${newStart}-${newEnd})`);

        // Verificar conflitos com appointments E bloqueios (apt-blocked)
        for (const event of (existingEvents || [])) {
            const eventStart = parseTime(event.start_time);
            const eventEnd = eventStart + (event.duration || 60);
            const eventType = event.type === 'apt-blocked' ? 'BLOQUEIO' : 'MARCAÇÃO';

            // Verifica sobreposição (qualquer sobreposição, mesmo parcial)
            if (newStart < eventEnd && newEnd > eventStart) {
                console.log(`[APPT] ❌ CONFLITO com ${eventType}: ${event.start_time} ${event.client_name} (${eventStart}-${eventEnd}) sobrepõe (${newStart}-${newEnd})`);
                return false; // Conflito encontrado
            }
        }

        // Verificar conflitos com eventos do Google Calendar
        for (const gEvent of googleEvents) {
            // Ignorar eventos de dia inteiro para verificação de horário específico
            if (gEvent.allDay) {
                console.log(`[APPT] ⚠️ Evento de dia inteiro no Google Calendar: ${gEvent.title}`);
                continue;
            }

            // Converter horários do Google Calendar (ISO format) para minutos
            const gStart = new Date(gEvent.start);
            const gEnd = new Date(gEvent.end);

            // Verificar se é do mesmo dia
            const eventDate = gStart.toISOString().split('T')[0];
            if (eventDate !== date) continue;

            const gStartMinutes = gStart.getHours() * 60 + gStart.getMinutes();
            const gEndMinutes = gEnd.getHours() * 60 + gEnd.getMinutes();

            // Verifica sobreposição
            if (newStart < gEndMinutes && newEnd > gStartMinutes) {
                console.log(`[APPT] ❌ CONFLITO com GOOGLE CALENDAR: "${gEvent.title}" (${gStartMinutes}-${gEndMinutes}) sobrepõe (${newStart}-${newEnd})`);
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
 * Encontra slots alternativos quando o horário pedido não está disponível
 * Prioridade: 1) Antes/depois no mesmo dia, 2) Próximo dia (primeira hora + hora pedida)
 */
async function findAlternativeSlots(userId, requestedDate, requestedTime, duration = 60) {
    try {
        const businessHours = await getUserBusinessHours(userId);
        const parseTime = (timeStr) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + (m || 0);
        };
        const formatTime = (minutes) => {
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        const requestedMinutes = parseTime(requestedTime);
        const alternatives = {
            sameDayBefore: null,
            sameDayAfter: null,
            nextDayFirstHour: null,
            nextDayRequestedTime: null
        };

        // Buscar appointments do dia pedido e do próximo dia
        // CORRIGIDO: Usar schema público (igual ao frontend)
        const nextDate = new Date(requestedDate);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateStr = nextDate.toISOString().split('T')[0];

        const { data: allEvents, error } = await supabase
            .from('appointments')
            .select('date, start_time, duration, type')
            .eq('user_id', userId)
            .in('date', [requestedDate, nextDateStr]);

        if (error) {
            console.error(`[APPT] Error finding alternatives:`, error);
            return alternatives;
        }

        // Criar mapa de slots ocupados (10 min granularity)
        const occupiedSlots = {};

        // Adicionar appointments ao mapa de slots ocupados
        (allEvents || []).forEach(apt => {
            const [startHour, startMinute] = apt.start_time.split(':').map(Number);
            const startInMinutes = startHour * 60 + (startMinute || 0);
            const aptDuration = apt.duration || 60;

            for (let m = 0; m < aptDuration; m += 10) {
                const slotMinutes = startInMinutes + m;
                const key = `${apt.date}:${formatTime(slotMinutes)}`;
                occupiedSlots[key] = true;
            }
        });

        // Buscar e adicionar eventos do Google Calendar ao mapa de slots ocupados
        const googleEventsToday = await getGoogleCalendarEvents(userId, requestedDate);
        const googleEventsTomorrow = await getGoogleCalendarEvents(userId, nextDateStr);
        const allGoogleEvents = [...googleEventsToday, ...googleEventsTomorrow];

        allGoogleEvents.forEach(gEvent => {
            // Ignorar eventos de dia inteiro
            if (gEvent.allDay) return;

            const gStart = new Date(gEvent.start);
            const gEnd = new Date(gEvent.end);
            const eventDate = gStart.toISOString().split('T')[0];

            const gStartMinutes = gStart.getHours() * 60 + gStart.getMinutes();
            const gEndMinutes = gEnd.getHours() * 60 + gEnd.getMinutes();
            const gDuration = gEndMinutes - gStartMinutes;

            // Marcar todos os slots ocupados pelo evento do Google Calendar
            for (let m = 0; m < gDuration; m += 10) {
                const slotMinutes = gStartMinutes + m;
                const key = `${eventDate}:${formatTime(slotMinutes)}`;
                occupiedSlots[key] = true;
            }
        });

        console.log(`[APPT] Occupied slots include ${allGoogleEvents.length} Google Calendar events`);

        // Função para verificar se um slot está disponível
        const isSlotAvailable = (date, startMinutes, dur) => {
            const dateObj = new Date(date);
            const dayOfWeek = dateObj.getDay();

            // Verificar dia de trabalho
            if (businessHours.workingDays && !businessHours.workingDays.includes(dayOfWeek)) {
                return false;
            }

            // Horários do dia
            let dayOpen = businessHours.open;
            let dayClose = businessHours.close;
            if (businessHours.hoursPerDay && businessHours.hoursPerDay[dayOfWeek]) {
                dayOpen = businessHours.hoursPerDay[dayOfWeek].open;
                dayClose = businessHours.hoursPerDay[dayOfWeek].close;
            }

            const openMinutes = dayOpen * 60;
            const closeMinutes = dayClose * 60;

            // Verificar se está dentro do horário
            if (startMinutes < openMinutes || (startMinutes + dur) > closeMinutes) {
                return false;
            }

            // Verificar se há conflito com slots ocupados
            for (let m = 0; m < dur; m += 10) {
                const key = `${date}:${formatTime(startMinutes + m)}`;
                if (occupiedSlots[key]) {
                    return false;
                }
            }

            return true;
        };

        // Obter horário de funcionamento do dia pedido
        const requestedDateObj = new Date(requestedDate);
        const dayOfWeek = requestedDateObj.getDay();
        let dayOpen = businessHours.open;
        let dayClose = businessHours.close;
        if (businessHours.hoursPerDay && businessHours.hoursPerDay[dayOfWeek]) {
            dayOpen = businessHours.hoursPerDay[dayOfWeek].open;
            dayClose = businessHours.hoursPerDay[dayOfWeek].close;
        }

        // 1. Procurar slot ANTES no mesmo dia (mais próximo possível)
        for (let m = requestedMinutes - 10; m >= dayOpen * 60; m -= 10) {
            if (isSlotAvailable(requestedDate, m, duration)) {
                alternatives.sameDayBefore = { date: requestedDate, time: formatTime(m) };
                break;
            }
        }

        // 2. Procurar slot DEPOIS no mesmo dia
        // MELHORADO: Encontrar o FIM do conflito atual e começar a procurar daí
        let searchStart = requestedMinutes + 10;

        // Se há um conflito no horário pedido, encontrar quando esse conflito termina
        for (const apt of (allEvents || [])) {
            if (apt.date !== requestedDate) continue;

            const [startHour, startMinute] = apt.start_time.split(':').map(Number);
            const aptStart = startHour * 60 + (startMinute || 0);
            const aptEnd = aptStart + (apt.duration || 60);

            // Se o horário pedido está dentro deste appointment, começar a procurar após o fim
            if (requestedMinutes >= aptStart && requestedMinutes < aptEnd) {
                // Arredondar para múltiplo de 10
                searchStart = Math.ceil(aptEnd / 10) * 10;
                console.log(`[APPT] Conflict ends at ${formatTime(aptEnd)}, searching from ${formatTime(searchStart)}`);
                break;
            }
        }

        // Também verificar eventos do Google Calendar
        for (const gEvent of allGoogleEvents) {
            if (gEvent.allDay) continue;
            const gStart = new Date(gEvent.start);
            const gEnd = new Date(gEvent.end);
            const eventDate = gStart.toISOString().split('T')[0];
            if (eventDate !== requestedDate) continue;

            const gStartMinutes = gStart.getHours() * 60 + gStart.getMinutes();
            const gEndMinutes = gEnd.getHours() * 60 + gEnd.getMinutes();

            if (requestedMinutes >= gStartMinutes && requestedMinutes < gEndMinutes) {
                const newSearchStart = Math.ceil(gEndMinutes / 10) * 10;
                if (newSearchStart > searchStart) {
                    searchStart = newSearchStart;
                    console.log(`[APPT] Google event ends at ${formatTime(gEndMinutes)}, searching from ${formatTime(searchStart)}`);
                }
            }
        }

        // Procurar slot DEPOIS (começando após o conflito)
        for (let m = searchStart; m <= (dayClose * 60 - duration); m += 10) {
            if (isSlotAvailable(requestedDate, m, duration)) {
                alternatives.sameDayAfter = { date: requestedDate, time: formatTime(m) };
                console.log(`[APPT] Found available slot after conflict: ${formatTime(m)}`);
                break;
            }
        }

        // 3. Próximo dia - primeira hora disponível
        const nextDayOfWeek = nextDate.getDay();
        if (!businessHours.workingDays || businessHours.workingDays.includes(nextDayOfWeek)) {
            let nextDayOpen = businessHours.open;
            let nextDayClose = businessHours.close;
            if (businessHours.hoursPerDay && businessHours.hoursPerDay[nextDayOfWeek]) {
                nextDayOpen = businessHours.hoursPerDay[nextDayOfWeek].open;
                nextDayClose = businessHours.hoursPerDay[nextDayOfWeek].close;
            }

            // Primeira hora do dia
            const firstHourMinutes = nextDayOpen * 60;
            if (isSlotAvailable(nextDateStr, firstHourMinutes, duration)) {
                alternatives.nextDayFirstHour = { date: nextDateStr, time: formatTime(firstHourMinutes) };
            }

            // Mesma hora pedida no dia seguinte
            if (isSlotAvailable(nextDateStr, requestedMinutes, duration)) {
                alternatives.nextDayRequestedTime = { date: nextDateStr, time: formatTime(requestedMinutes) };
            }
        }

        console.log(`[APPT] Found alternatives:`, alternatives);
        return alternatives;

    } catch (err) {
        console.error(`[APPT] Error finding alternatives:`, err);
        return { sameDayBefore: null, sameDayAfter: null, nextDayFirstHour: null, nextDayRequestedTime: null };
    }
}

/**
 * Formata data para exibição natural em português
 */
function formatDateForDisplay(dateStr) {
    const dateObj = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateOnly = new Date(dateStr);
    dateOnly.setHours(0, 0, 0, 0);

    if (dateOnly.getTime() === today.getTime()) {
        return 'hoje';
    } else if (dateOnly.getTime() === tomorrow.getTime()) {
        return 'amanhã';
    } else {
        const diffDays = Math.ceil((dateOnly - today) / (1000 * 60 * 60 * 24));
        if (diffDays <= 5) {
            return dateObj.toLocaleDateString('pt-PT', { weekday: 'long' });
        } else {
            return dateObj.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long' });
        }
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
 * CORRIGIDO: Usar schema público (igual ao frontend)
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
 * DELETE /appointments/:userId/:id - Cancelar agendamento
 * CORRIGIDO: Usar schema público (igual ao frontend)
 */
app.delete('/appointments/:userId/:id', async (req, res) => {
    const { userId, id } = req.params;

    try {
        await supabase
            .from('appointments')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);

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
 * Itera por todos os tenants para verificar mensagens pendentes
 */
async function processScheduledMessages() {
    try {
        const now = new Date().toISOString();
        console.log(`[SCHEDULER] A verificar mensagens às ${now}`);

        // Buscar todos os tenants activos
        const { data: tenants, error: tenantsError } = await supabase
            .from('tenants')
            .select('user_id, schema_name');

        if (tenantsError) {
            console.error('[SCHEDULER] Erro ao buscar tenants:', tenantsError);
            return;
        }

        // Buscar mensagens pendentes de todos os tenants
        let allMessages = [];
        for (const t of (tenants || [])) {
            const scheduled = await tenant.scheduledMessages(t.user_id);
            const { data: messages, error } = await scheduled
                .select('*')
                .eq('status', 'pending')
                .lte('scheduled_at', now);

            if (!error && messages && messages.length > 0) {
                // Adicionar user_id a cada mensagem para saber de qual tenant é
                allMessages = allMessages.concat(
                    messages.map(m => ({ ...m, user_id: t.user_id }))
                );
            }
        }

        if (allMessages.length === 0) {
            // Log ocasional para confirmar que está a funcionar
            return;
        }

        // Usar allMessages em vez de messages
        const messages = allMessages;

        console.log(`[SCHEDULER] ${messages.length} mensagens para enviar`);

        for (const msg of messages) {
            console.log(`[SCHEDULER] A processar mensagem ${msg.id} para ${msg.to_number} (user: ${msg.user_id})`);

            const session = userSessions.get(msg.user_id);

            if (!session || session.status !== 'connected') {
                // User não conectado, marcar como falhado
                const sessionStatus = session ? session.status : 'sem sessão';
                const activeSessions = Array.from(userSessions.keys());
                console.log(`[SCHEDULER] FALHOU - Sessão não conectada. Status: ${sessionStatus}. Sessões ativas: ${activeSessions.join(', ') || 'nenhuma'}`);

                const scheduledTable = await tenant.scheduledMessages(msg.user_id);
                await scheduledTable
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
                    const scheduledTable = await tenant.scheduledMessages(msg.user_id);
                    await scheduledTable
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
                const scheduledTable = await tenant.scheduledMessages(msg.user_id);
                await scheduledTable
                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                    .eq('id', msg.id);

                // Nota: whatsapp_messages não migrada para schema (pode ser adicionada depois)
                // Por agora, as mensagens são guardadas na tabela pública
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
                const scheduledTable = await tenant.scheduledMessages(msg.user_id);
                await scheduledTable
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

    // Iniciar sistema de heartbeat/auto-reconexão
    startHeartbeat();
});
// Force redeploy Wed Jan 14 21:49:30 WET 2026
// Forced rebuild Wed Jan 14 22:04:08 WET 2026
// Deploy Tue Jan 20 00:37:07 WET 2026
// Deploy Mon Jan 20 07:00:00 WET 2026 - AI only books on AVAILABLE slots, stricter instructions
// Deploy Tue Jan 20 07:28:04 WET 2026
// Deploy Tue Jan 21 06:20:00 WET 2026 - Added heartbeat/auto-reconnect system
// Deploy Tue Jan 21 08:00:00 WET 2026 - Added detailed logging for availability calculation
// Deploy Tue Jan 21 - AI now sees OCCUPIED slots explicitly to avoid suggesting them
// Deploy Tue Jan 21 - AI prioritizes ADJACENT slots (next to existing appointments) first
// Deploy Wed Jan 22 - STRICTER blocking: AI now has stronger instructions to NEVER book blocked slots
// Deploy Wed Jan 22 - AI now prioritizes SAME DAY alternatives when requested time is unavailable
// Deploy Wed Jan 22 - AI must include 😊 emoji in first message of every conversation
// Deploy Wed Jan 22 - When slot unavailable, REPLACE ENTIRE response (not just [AGENDAR] tag)
// Deploy Wed Jan 22 - Date format: weekday only for <=5 days, day+month for >5 days
