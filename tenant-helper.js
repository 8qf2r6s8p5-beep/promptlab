/**
 * TENANT HELPER
 * Helper para aceder aos schemas de cada tenant
 *
 * Uso:
 *   const tenant = new TenantHelper(supabase);
 *   const schema = await tenant.getSchema(userId);
 *   const articles = await tenant.query(userId, 'knowledge_base').select('*');
 */

class TenantHelper {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.schemaCache = new Map(); // Cache de user_id -> schema_name
        this.CACHE_TTL = 5 * 60 * 1000; // 5 minutos
    }

    /**
     * Obter o schema de um user (com cache)
     */
    async getSchema(userId) {
        // Verificar cache
        const cached = this.schemaCache.get(userId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.schema;
        }

        // Buscar do Supabase
        const { data, error } = await this.supabase
            .from('tenants')
            .select('schema_name')
            .eq('user_id', userId)
            .single();

        if (error || !data) {
            console.error(`[TENANT] Schema não encontrado para user ${userId}:`, error?.message);
            return null;
        }

        // Guardar em cache
        this.schemaCache.set(userId, {
            schema: data.schema_name,
            timestamp: Date.now()
        });

        return data.schema_name;
    }

    /**
     * Criar query para uma tabela do tenant
     * Retorna um query builder do Supabase com o schema correcto
     */
    async query(userId, tableName) {
        const schema = await this.getSchema(userId);
        if (!schema) {
            throw new Error(`Tenant não encontrado para user ${userId}`);
        }

        return this.supabase.schema(schema).from(tableName);
    }

    /**
     * Atalhos para tabelas comuns
     */
    async knowledgeBase(userId) {
        return this.query(userId, 'knowledge_base');
    }

    async appointments(userId) {
        return this.query(userId, 'appointments');
    }

    async whatsappContacts(userId) {
        return this.query(userId, 'whatsapp_contacts');
    }

    async scheduledMessages(userId) {
        return this.query(userId, 'scheduled_messages');
    }

    async agendaAvailability(userId) {
        return this.query(userId, 'agenda_availability');
    }

    /**
     * Executar query directa com schema
     */
    async select(userId, tableName, columns = '*') {
        const q = await this.query(userId, tableName);
        return q.select(columns);
    }

    async insert(userId, tableName, data) {
        const q = await this.query(userId, tableName);
        return q.insert(data);
    }

    async update(userId, tableName, data, filters = {}) {
        const q = await this.query(userId, tableName);
        let query = q.update(data);

        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
        }

        return query;
    }

    async delete(userId, tableName, filters = {}) {
        const q = await this.query(userId, tableName);
        let query = q.delete();

        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
        }

        return query;
    }

    /**
     * Limpar cache (útil após criar novo tenant)
     */
    clearCache(userId = null) {
        if (userId) {
            this.schemaCache.delete(userId);
        } else {
            this.schemaCache.clear();
        }
    }

    /**
     * Verificar se um user tem tenant
     */
    async hasTenant(userId) {
        const schema = await this.getSchema(userId);
        return schema !== null;
    }

    /**
     * Criar novo tenant (chama a função SQL)
     */
    async createTenant(userId, displayName = null) {
        const { data, error } = await this.supabase
            .rpc('create_tenant_schema', {
                p_user_id: userId,
                p_display_name: displayName
            });

        if (error) {
            console.error(`[TENANT] Erro ao criar tenant:`, error.message);
            throw error;
        }

        // Limpar cache para forçar refresh
        this.clearCache(userId);

        console.log(`[TENANT] Criado schema ${data} para user ${userId}`);
        return data;
    }
}

module.exports = { TenantHelper };
