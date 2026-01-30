/**
 * SCHEDULING ENGINE v4.0 - VERSÃO NODE.JS
 * Motor de cálculo de disponibilidade para AI
 *
 * Versão server-side para WhatsApp - PARTILHA LÓGICA COM APP
 *
 * Uso:
 *   const { SchedulingEngine } = require('./scheduling-engine-server');
 *   const engine = new SchedulingEngine(supabase);
 *   await engine.initialize(userId);
 *   const context = engine.generateAIContext();
 */

'use strict';

const SLOT_GRANULARITY = 10;  // Slots de 10 em 10 minutos
const DAYS_TO_CHECK = 7;
const DEFAULT_SERVICE_DURATION = 60; // Duração padrão em minutos
const CALENDAR_API_URL = 'https://calendario-production-003b.up.railway.app';

// ========== UTILITÁRIOS ==========

function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    return parts[0] * 60 + (parts[1] || 0);
}

function minutesToTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function getDayName(date) {
    return date.toLocaleDateString('pt-PT', { weekday: 'long' });
}

// ========== CLASSE PRINCIPAL ==========

class SchedulingEngine {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.userId = null;
        this.config = null;
        this.appointments = [];
        this.blockedRanges = {};
        this.availableSlots = {};
        this.initialized = false;
    }

    /**
     * Carregar configuração do Supabase
     */
    async loadConfig() {
        console.log('[SCHEDULING-SERVER] Loading config...');

        const defaults = {
            serviceDuration: 60,
            hoursPerDay: null,
            workingDays: [0, 1, 2, 3, 4, 5, 6],
            businessHours: { open: 9, close: 18 },
            productDurationEnabled: false,
            products: []
        };

        if (!this.supabase || !this.userId) {
            console.warn('[SCHEDULING-SERVER] Supabase or userId not available, using defaults');
            this.config = { ...defaults };
            return this.config;
        }

        try {
            const { data: profile, error } = await this.supabase
                .from('profiles')
                .select('fixed_service_duration, hours_per_day, working_days, business_hour_open, business_hour_close, product_duration_enabled')
                .eq('id', this.userId)
                .single();

            if (error) throw error;

            let hoursPerDay = profile.hours_per_day;
            let workingDays = profile.working_days;

            this.config = {
                serviceDuration: profile.fixed_service_duration || defaults.serviceDuration,
                hoursPerDay: hoursPerDay || defaults.hoursPerDay,
                workingDays: (workingDays || defaults.workingDays).map(d => parseInt(d, 10)),
                businessHours: {
                    open: profile.business_hour_open ?? defaults.businessHours.open,
                    close: profile.business_hour_close ?? defaults.businessHours.close
                },
                productDurationEnabled: profile.product_duration_enabled || false,
                products: []
            };

            // Carregar produtos se modo duração por produto está activo
            if (this.config.productDurationEnabled) {
                const { data: products, error: prodError } = await this.supabase
                    .from('products')
                    .select('id, name, duration, price, active')
                    .eq('user_id', this.userId)
                    .eq('active', true);

                if (!prodError && products) {
                    this.config.products = products
                        .filter(p => p.duration)
                        .map(p => ({
                            id: p.id,
                            name: p.name,
                            duration: p.duration,
                            price: p.price
                        }));
                }
            }

            console.log('[SCHEDULING-SERVER] Config loaded:', this.config);
            return this.config;

        } catch (err) {
            console.error('[SCHEDULING-SERVER] Error loading config:', err);
            this.config = { ...defaults };
            return this.config;
        }
    }

    /**
     * Carregar TODOS os appointments (Supabase + Google Calendar)
     */
    async loadAppointments() {
        console.log('[SCHEDULING-SERVER] Loading appointments...');
        this.appointments = [];

        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(today.getDate() + DAYS_TO_CHECK);

        const todayStr = formatDate(today);
        const endStr = formatDate(endDate);

        // Carregar do Supabase
        if (this.supabase && this.userId) {
            try {
                const { data: apts, error } = await this.supabase
                    .from('appointments')
                    .select('date, start_time, duration, type, client_name')
                    .eq('user_id', this.userId)
                    .gte('date', todayStr)
                    .lte('date', endStr);

                if (!error && apts) {
                    apts.forEach(apt => {
                        this.appointments.push({
                            date: apt.date,
                            start: (apt.start_time || '').substring(0, 5),
                            duration: apt.duration || 60,
                            type: apt.type,
                            source: 'supabase',
                            client: apt.client_name
                        });
                    });
                    console.log('[SCHEDULING-SERVER] Loaded', apts.length, 'appointments from Supabase');
                }
            } catch (err) {
                console.error('[SCHEDULING-SERVER] Error loading from Supabase:', err);
            }
        }

        // Carregar eventos do Google Calendar
        if (this.userId) {
            try {
                console.log('[SCHEDULING-SERVER] Fetching Google Calendar events...');
                const response = await fetch(`${CALENDAR_API_URL}/events/${this.userId}`);

                if (response.ok) {
                    const data = await response.json();

                    if (data.events && !data.error) {
                        console.log('[SCHEDULING-SERVER] Google Calendar events:', data.events.length);

                        data.events.forEach(event => {
                            // Ignorar eventos de dia inteiro
                            if (event.allDay) return;

                            const startDate = new Date(event.start);
                            const endDateEvent = event.end ? new Date(event.end) : null;

                            if (isNaN(startDate.getTime())) return;

                            const eventDateStr = formatDate(startDate);
                            const startTime = `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;

                            // Calcular duração
                            let durationMins = 60;
                            if (endDateEvent && !isNaN(endDateEvent.getTime())) {
                                durationMins = Math.round((endDateEvent - startDate) / (1000 * 60));
                                if (durationMins <= 0) durationMins = 60;
                            }

                            // Evitar duplicados
                            const exists = this.appointments.some(
                                a => a.date === eventDateStr && a.start === startTime
                            );

                            if (!exists) {
                                this.appointments.push({
                                    date: eventDateStr,
                                    start: startTime,
                                    duration: durationMins,
                                    type: 'gcal-event',
                                    source: 'google',
                                    title: event.summary
                                });
                            }
                        });
                    }
                }
            } catch (err) {
                console.error('[SCHEDULING-SERVER] Google Calendar error:', err);
            }
        }

        console.log('[SCHEDULING-SERVER] Total appointments loaded:', this.appointments.length);
        return this.appointments;
    }

    /**
     * Calcular blocos ocupados
     */
    calculateBlockedRanges() {
        console.log('[SCHEDULING-SERVER] Calculating blocked ranges...');
        this.blockedRanges = {};

        this.appointments.forEach(apt => {
            const date = apt.date;
            if (!this.blockedRanges[date]) this.blockedRanges[date] = [];

            const startMins = timeToMinutes(apt.start);
            const duration = apt.duration || DEFAULT_SERVICE_DURATION;
            const endMins = startMins + duration;

            this.blockedRanges[date].push({
                start: startMins,
                end: endMins,
                duration: duration,
                display: `${apt.start}-${minutesToTime(endMins)}`,
                client: apt.client || apt.title || 'Ocupado',
                type: apt.type || 'apt-booked',
                source: apt.source || 'manual'
            });
        });

        // Ordenar por início
        Object.keys(this.blockedRanges).forEach(date => {
            this.blockedRanges[date].sort((a, b) => a.start - b.start);
        });

        return this.blockedRanges;
    }

    /**
     * Obter horário de funcionamento para um dia
     */
    getDayHours(date) {
        const dayOfWeek = date.getDay();
        const { hoursPerDay, workingDays, businessHours } = this.config;

        // Verificar se é dia de trabalho
        if (!workingDays.includes(dayOfWeek)) {
            console.log(`[SCHEDULING-SERVER] getDayHours: day ${dayOfWeek} not in workingDays`, workingDays);
            return null;
        }

        // Tentar horário específico do dia
        if (hoursPerDay) {
            const dayConfig = hoursPerDay[dayOfWeek] || hoursPerDay[String(dayOfWeek)];
            console.log(`[SCHEDULING-SERVER] getDayHours: day ${dayOfWeek}, config found:`, dayConfig);
            if (dayConfig && dayConfig.open !== undefined && dayConfig.close !== undefined) {
                return {
                    open: dayConfig.open,
                    close: dayConfig.close,
                    openMins: dayConfig.open * 60,
                    closeMins: dayConfig.close * 60
                };
            }
        }

        // Fallback para horário global
        return {
            open: businessHours.open,
            close: businessHours.close,
            openMins: businessHours.open * 60,
            closeMins: businessHours.close * 60
        };
    }

    /**
     * Verificar se um slot está disponível
     */
    isSlotAvailable(dateStr, requestedMins, overrideDuration = null) {
        const date = new Date(dateStr + 'T12:00:00');
        const dayHours = this.getDayHours(date);

        const effectiveDuration = overrideDuration !== null
            ? overrideDuration
            : this.getEffectiveDuration();

        if (!dayHours) {
            return { available: false, reason: 'closed_day' };
        }

        if (requestedMins < dayHours.openMins) {
            return { available: false, reason: 'before_open' };
        }

        const endMins = requestedMins + effectiveDuration;
        if (endMins > dayHours.closeMins) {
            return { available: false, reason: 'exceeds_closing' };
        }

        const dayBlocks = this.blockedRanges[dateStr] || [];
        for (const block of dayBlocks) {
            if (requestedMins < block.end && endMins > block.start) {
                return { available: false, reason: 'conflict', conflictWith: block.display };
            }
        }

        return { available: true, effectiveDuration };
    }

    /**
     * Obter duração efectiva baseada na configuração
     */
    getEffectiveDuration(specificProductId = null) {
        const { serviceDuration, productDurationEnabled, products } = this.config;

        if (specificProductId && products) {
            const product = products.find(p => p.id === specificProductId);
            if (product && product.duration) {
                return product.duration;
            }
        }

        if (productDurationEnabled && products && products.length > 0) {
            const minDuration = Math.min(...products.map(p => p.duration || DEFAULT_SERVICE_DURATION));
            return minDuration;
        }

        return serviceDuration || DEFAULT_SERVICE_DURATION;
    }

    /**
     * Calcular TODOS os slots disponíveis
     */
    calculateAllAvailableSlots() {
        console.log('[SCHEDULING-SERVER] Calculating available slots...');
        this.availableSlots = {};

        const effectiveDuration = this.getEffectiveDuration();
        console.log(`[SCHEDULING-SERVER] Using effective duration: ${effectiveDuration} min`);

        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();

        for (let d = 0; d < DAYS_TO_CHECK; d++) {
            const checkDate = new Date();
            checkDate.setDate(checkDate.getDate() + d);
            const dateStr = formatDate(checkDate);
            const dayHours = this.getDayHours(checkDate);
            const isToday = d === 0;

            if (!dayHours) continue;

            const slots = [];
            const lastPossibleStart = dayHours.closeMins - effectiveDuration;

            let startMins = dayHours.openMins;
            if (isToday) {
                const nextSlot = Math.ceil(currentMins / SLOT_GRANULARITY) * SLOT_GRANULARITY;
                startMins = Math.max(startMins, nextSlot);
            }

            for (let mins = startMins; mins <= lastPossibleStart; mins += SLOT_GRANULARITY) {
                const result = this.isSlotAvailable(dateStr, mins, effectiveDuration);
                if (result.available) {
                    slots.push(mins);
                }
            }

            this.availableSlots[dateStr] = {
                date: checkDate,
                dateStr: dateStr,
                dayName: getDayName(checkDate),
                dayOfWeek: checkDate.getDay(),
                hours: dayHours,
                slots: slots,
                slotsFormatted: slots.map(m => minutesToTime(m)),
                effectiveDuration: effectiveDuration
            };
        }

        return this.availableSlots;
    }

    /**
     * Gerar contexto para o AI - VERSÃO OTIMIZADA v4.3
     * IDENTICO À VERSÃO BROWSER - GARANTE CONSISTÊNCIA
     */
    generateAIContext() {
        const { productDurationEnabled, products } = this.config;
        const effectiveDuration = this.getEffectiveDuration();

        let context = '\n\n=== 📅 SISTEMA DE AGENDAMENTOS ===\n\n';

        // Data e hora actual com DEBUG
        const now = new Date();
        const hoje = now.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
        context += `📆 HOJE: ${hoje}\n`;
        context += `⏰ HORA ACTUAL: ${now.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}\n`;
        context += `🔧 DURAÇÃO SERVIÇO: ${effectiveDuration} minutos\n\n`;

        // Serviços disponíveis (se modo produto activo)
        if (productDurationEnabled && products && products.length > 0) {
            context += '🛠️ SERVIÇOS DISPONÍVEIS:\n';
            products.forEach(p => {
                const price = p.price ? ` - ${p.price}€` : '';
                context += `• ${p.name} (${p.duration} min)${price}\n`;
            });
            context += '\n';
        } else {
            context += `⏱️ DURAÇÃO PADRÃO: ${effectiveDuration} minutos\n\n`;
        }

        // HORÁRIOS OCUPADOS (CRÍTICO - AI não pode agendar aqui)
        let hasOccupied = false;
        Object.keys(this.blockedRanges).sort().forEach(dateStr => {
            const blocks = this.blockedRanges[dateStr];
            if (blocks && blocks.length > 0) {
                if (!hasOccupied) {
                    context += '🚫 HORÁRIOS OCUPADOS (verifica SOBREPOSIÇÃO!):\n';
                    hasOccupied = true;
                }
                const dayData = this.availableSlots[dateStr];
                const dayLabel = dayData ? dayData.dayName : dateStr;
                const blocksStr = blocks.map(b => `${b.display}`).join(', ');
                context += `• ${dayLabel} (${dateStr}): ${blocksStr}\n`;
            }
        });
        // Calcular e mostrar JANELAS LIVRES para ajudar o AI
        if (hasOccupied) {
            context += '\n✅ JANELAS LIVRES (aceita qualquer horário nestas ranges):\n';
            Object.keys(this.blockedRanges).sort().slice(0, 3).forEach(dateStr => {
                const blocks = this.blockedRanges[dateStr] || [];
                const dayData = this.availableSlots[dateStr];
                if (!dayData) return;

                const dayLabel = dayData.dayName;
                const openMins = dayData.hours.openMins;
                const closeMins = dayData.hours.closeMins;

                // Sort blocks by start time
                const sorted = [...blocks].sort((a, b) => a.start - b.start);
                const freeWindows = [];
                let cursor = openMins;

                for (const block of sorted) {
                    if (block.start > cursor) {
                        freeWindows.push(`${minutesToTime(cursor)}-${minutesToTime(block.start)}`);
                    }
                    cursor = Math.max(cursor, block.end);
                }
                if (cursor < closeMins) {
                    freeWindows.push(`${minutesToTime(cursor)}-${minutesToTime(closeMins)}`);
                }

                if (freeWindows.length > 0) {
                    context += `• ${dayLabel}: ${freeWindows.join(', ')}\n`;
                }
            });
            context += '\n';
        }

        // HORÁRIOS DISPONÍVEIS - v4.3 PRÉ-CALCULADO para cada serviço
        context += '✅ PRIMEIRO HORÁRIO LIVRE POR SERVIÇO:\n';

        let hasAvailable = false;

        // v4.3: Para cada dia, calcular o primeiro slot disponível para CADA serviço
        Object.keys(this.availableSlots).sort().slice(0, 5).forEach(dateStr => {
            const dayData = this.availableSlots[dateStr];
            if (!dayData) return;

            const openTime = minutesToTime(dayData.hours.openMins);
            const closeTime = minutesToTime(dayData.hours.closeMins);
            const dayBlocks = this.blockedRanges[dateStr] || [];

            hasAvailable = true;

            if (productDurationEnabled && products && products.length > 0) {
                // v4.3: Calcular primeiro slot para CADA serviço
                const serviceSlots = products.map(p => {
                    const firstSlot = this._findFirstAvailableSlot(dateStr, p.duration, dayData.hours, dayBlocks);
                    return firstSlot ? `${p.name}: ${minutesToTime(firstSlot)}` : `${p.name}: LOTADO`;
                });

                context += `• ${dayData.dayName} (${dateStr}) [${openTime}-${closeTime}]:\n`;
                serviceSlots.forEach(s => context += `  → ${s}\n`);
            } else {
                // Modo simples
                if (dayData.slots.length === 0) {
                    context += `• ${dayData.dayName} (${dateStr}): ❌ LOTADO\n`;
                    return;
                }
                const firstSlot = minutesToTime(dayData.slots[0]);
                context += `• ${dayData.dayName} (${dateStr}) [${openTime}-${closeTime}]: primeiro livre ${firstSlot}\n`;
            }
        });

        if (!hasAvailable) {
            context += '⚠️ Sem horários disponíveis nos próximos dias.\n';
        }

        // Dias fechados
        const closedDays = [];
        const dayNames = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
        for (let d = 0; d < 7; d++) {
            if (!this.config.workingDays.includes(d)) {
                closedDays.push(dayNames[d]);
            }
        }
        if (closedDays.length > 0) {
            context += `\n🚷 DIAS FECHADOS: ${closedDays.join(', ')}\n`;
        }

        // Instruções para o AI - v4.7 EXEMPLOS CONCRETOS
        context += `\n📋 COMO RESPONDER:

EXEMPLO 1 - Cliente pede horário LIVRE:
Cliente: "Pode ser às 8h?"
Resposta: "Sim! Posso às 08:00. Confirmas?"

EXEMPLO 2 - Cliente pede horário OCUPADO:
Cliente: "Quero às 10h"
Resposta: "Não tenho às 10h. Tenho às 08:00. Pode ser?"

EXEMPLO 3 - Cliente pede outro horário LIVRE:
Cliente: "E às 15h?"
Resposta: "Sim! Tenho às 15h. Confirmas?"

REGRA: Se horário NÃO sobrepõe OCUPADOS → aceita. Se SOBREPÕE → rejeita e sugere primeiro livre.
Respostas CURTAS (2 frases), sem markdown.
- Comando: [AGENDA_COMMAND]{"action":"add","date":"YYYY-MM-DD","start":"HH:MM","duration":X,"client":"NOME","notes":"SERVIÇO"}[/AGENDA_COMMAND]\n`;

        return context;
    }

    /**
     * v4.3: Encontrar primeiro slot disponível para uma duração específica
     * @private
     * @param {string} dateStr - Data YYYY-MM-DD
     * @param {number} duration - Duração do serviço em minutos
     * @param {Object} hours - { openMins, closeMins }
     * @param {Array} blocks - Blocos ocupados [{ start, end }, ...]
     * @returns {number|null} - Minutos do primeiro slot livre, ou null se lotado
     */
    _findFirstAvailableSlot(dateStr, duration, hours, blocks) {
        const now = new Date();
        const today = formatDate(now);
        const isToday = dateStr === today;
        const currentMins = now.getHours() * 60 + now.getMinutes();

        // Último slot possível = fecho - duração
        const lastPossibleStart = hours.closeMins - duration;
        if (lastPossibleStart < hours.openMins) return null; // Serviço maior que dia útil

        // Começar da abertura ou do próximo slot se for hoje
        let startMins = hours.openMins;
        if (isToday) {
            const nextSlot = Math.ceil(currentMins / SLOT_GRANULARITY) * SLOT_GRANULARITY;
            startMins = Math.max(startMins, nextSlot);
        }

        // Iterar slots de 10 em 10 minutos
        for (let slot = startMins; slot <= lastPossibleStart; slot += SLOT_GRANULARITY) {
            const slotEnd = slot + duration;

            // Verificar se sobrepõe algum bloco ocupado
            let hasConflict = false;
            for (const block of blocks) {
                // Conflito: slot < block.end E slotEnd > block.start
                if (slot < block.end && slotEnd > block.start) {
                    hasConflict = true;
                    break;
                }
            }

            if (!hasConflict) {
                return slot; // Primeiro slot livre encontrado
            }
        }

        return null; // Dia lotado para esta duração
    }

    /**
     * Calcular janelas de disponibilidade contínuas
     * @private
     */
    _calculateWindows(slots) {
        const windows = [];
        if (!slots || slots.length === 0) return windows;

        let winStart = slots[0];
        let prevSlot = slots[0];

        for (let i = 1; i < slots.length; i++) {
            const slot = slots[i];
            if (slot - prevSlot > SLOT_GRANULARITY) {
                windows.push({ start: winStart, end: prevSlot });
                winStart = slot;
            }
            prevSlot = slot;
        }
        windows.push({ start: winStart, end: prevSlot });

        return windows;
    }

    /**
     * Inicialização completa
     */
    async initialize(userId) {
        console.log('[SCHEDULING-SERVER] Initializing for user:', userId);
        this.userId = userId;

        await this.loadConfig();
        await this.loadAppointments();
        this.calculateBlockedRanges();
        this.calculateAllAvailableSlots();

        this.initialized = true;
        console.log('[SCHEDULING-SERVER] Ready');

        return this;
    }

    /**
     * Refresh (recarregar dados)
     */
    async refresh() {
        await this.loadAppointments();
        this.calculateBlockedRanges();
        this.calculateAllAvailableSlots();
        return this;
    }
}

// ========== EXPORTS ==========

module.exports = {
    SchedulingEngine,
    utils: {
        timeToMinutes,
        minutesToTime,
        formatDate,
        getDayName
    }
};
