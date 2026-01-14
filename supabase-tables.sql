-- ==========================================
-- TABELAS PARA WHATSAPP - PromptLab
-- Corre este SQL no Supabase SQL Editor
-- ==========================================

-- 1. Adicionar colunas à tabela profiles (se não existirem)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS whatsapp_status TEXT DEFAULT 'disconnected',
ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT,
ADD COLUMN IF NOT EXISTS whatsapp_updated_at TIMESTAMPTZ;

-- 2. Tabela de mensagens WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('sent', 'received')),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabela de mensagens agendadas
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    to_number TEXT NOT NULL,
    message TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Índices para performance
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_user_id ON whatsapp_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_timestamp ON whatsapp_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user_id ON scheduled_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status ON scheduled_messages(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_at ON scheduled_messages(scheduled_at);

-- 5. RLS (Row Level Security) - Users só veem as próprias mensagens
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Políticas para whatsapp_messages
CREATE POLICY "Users can view own messages" ON whatsapp_messages
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own messages" ON whatsapp_messages
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Políticas para scheduled_messages
CREATE POLICY "Users can view own scheduled" ON scheduled_messages
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own scheduled" ON scheduled_messages
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own scheduled" ON scheduled_messages
    FOR UPDATE USING (auth.uid() = user_id);

-- 6. Política para o servidor (service role) poder atualizar
-- Nota: O servidor usa a service_role key, que bypassa RLS automaticamente
