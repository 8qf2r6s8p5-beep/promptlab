# Deploy WhatsApp Server - PromptLab

## Passo 1: Criar tabelas no Supabase

1. Abre o Supabase: https://supabase.com/dashboard
2. Vai a **SQL Editor**
3. Cola o conteúdo do ficheiro `supabase-tables.sql`
4. Clica **Run**

---

## Passo 2: Deploy na Hostinger

### 2.1 Aceder ao painel

1. Entra na Hostinger: https://hpanel.hostinger.com
2. Vai a **Websites** → **prompt-lab.cloud**
3. Procura **Node.js** ou **Web Apps** no menu lateral

### 2.2 Criar nova aplicação Node.js

1. Clica em **Create** ou **Add Application**
2. Escolhe:
   - **Runtime**: Node.js 18 ou superior
   - **Start command**: `npm start`
   - **Port**: 3001

### 2.3 Upload dos ficheiros

**Opção A - Via GitHub (recomendado):**
1. Cria repositório no GitHub com a pasta `whatsapp-server`
2. Conecta o repositório na Hostinger
3. Deploy automático

**Opção B - Upload manual:**
1. Comprime a pasta `whatsapp-server` em ZIP
2. Faz upload via File Manager da Hostinger
3. Extrai no diretório da aplicação

### 2.4 Instalar dependências

No terminal da Hostinger (SSH ou Console):
```bash
cd whatsapp-server
npm install
```

### 2.5 Iniciar aplicação

```bash
npm start
```

---

## Passo 3: Configurar domínio/subdomínio

Recomendo criar um subdomínio para a API:

1. Vai a **Domains** → **Subdomains**
2. Cria: `api.prompt-lab.cloud` ou `wa.prompt-lab.cloud`
3. Aponta para a aplicação Node.js

---

## Passo 4: Testar

Abre no browser:
```
https://api.prompt-lab.cloud/health
```

Deves ver:
```json
{"status": "online", "timestamp": "..."}
```

---

## Passo 5: Atualizar frontend

No teu código frontend, atualiza a URL da API:

```javascript
const WHATSAPP_API_URL = 'https://api.prompt-lab.cloud';
```

---

## Troubleshooting

### Erro: puppeteer não funciona
A Hostinger pode não ter Chrome instalado. Solução:
1. Adiciona no package.json: `"puppeteer": "^21.0.0"`
2. Ou usa `puppeteer-core` com Chrome do sistema

### Erro: porta já em uso
Muda a PORT no index.js ou nas variáveis de ambiente

### WhatsApp desconecta sozinho
Normal se ninguém usa por muito tempo. O QR Code expira após ~60 segundos.

---

## Notas importantes

1. **Sessões WhatsApp** são guardadas localmente (pasta `.wwebjs_auth`)
2. Se reiniciares o servidor, users podem precisar de escanear QR novamente
3. Máximo ~5 sessões WhatsApp simultâneas (limite da biblioteca)
4. Não é a API oficial do WhatsApp - usa por tua conta e risco
