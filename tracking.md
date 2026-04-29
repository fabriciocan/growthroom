# Setup de Tracking Meta CAPI — Novo Site (Astro)

> Guia para o Claude Code preparar um novo site Astro com tracking Meta (Pixel + Conversions API) deduplicado, replicando a arquitetura validada da Pixformance.

---

## Objetivo

Implementar tracking de conversões para o Meta com:

- **Deduplicação browser ↔ server** via `event_id` único gerado no client
- **CAPI server side** via n8n (não Zapier) para garantir entrega e qualidade de hash
- **EMQ alto** (target 8+/10) com `em`, `ph`, `fn`, `ln`, `fbp`, `fbc`, `client_ip_address`, `client_user_agent`
- **Compliance GDPR** (especialmente DACH) via gate de consent Usercentrics antes do disparo CAPI
- **Sem race conditions** — o script Astro é a fonte única de verdade do `event_id`

---

## Arquitetura

```
Browser (Astro + script inline)
  ├── Gera event_id no page load → window.dataLayer
  ├── Lê _fbp / _fbc dos cookies
  ├── Hash SHA-256 client side (em, ph, fn, ln) via Web Crypto API
  ├── Push meta_user_data_ready → GTM dispara FBA Lead (Pixel)
  └── POST → webhook n8n
                ├── Captura IP via x-forwarded-for / cf-connecting-ip
                ├── Salva no CRM (Zoho/HubSpot/etc) com campos custom
                ├── Reconstrói fbc no servidor se cookie ausente
                ├── Verifica marketing_consent
                └── POST CAPI (event_id IGUAL ao do browser → dedup ✅)
```

---

## Pré-requisitos (cliente precisa fornecer)

- [ ] **Pixel ID do Meta** (formato `123456789012345`)
- [ ] **CAPI Access Token** (gerado em Events Manager → Settings → Conversions API)
- [ ] **URL do webhook n8n** (ex: `https://webhook.dominio.com/webhook/site-forms`)
- [ ] **Domínio de produção** do site
- [ ] **CRM em uso** (Zoho, HubSpot, ActiveCampaign, etc) e credenciais de API
- [ ] **Solução de consent** em uso (Usercentrics, Cookiebot, custom) — necessário para compliance GDPR/DACH
- [ ] **Container GTM ID** (formato `GTM-XXXXXX`)

---

## Passo 1 — Componente `MetaEventId.astro` (fonte única do event_id)

Criar em `src/components/MetaEventId.astro`. Este componente vai no `<head>` do `Layout.astro` global, **antes** do GTM e antes do Meta Pixel.

```astro
---
// MetaEventId.astro
// Importar no <head> do Layout.astro: <MetaEventId />
// CRÍTICO: deve carregar ANTES do GTM e do Meta Pixel
---

<script is:inline>
  (function () {
    function generateEventId() {
      return Date.now() + '_' + Math.floor(Math.random() * 1e15);
    }

    function initEventId() {
      window.dataLayer = window.dataLayer || [];

      // Reaproveita event_id existente se já houver (raro)
      for (var i = window.dataLayer.length - 1; i >= 0; i--) {
        if (window.dataLayer[i] && window.dataLayer[i].event_id) {
          window.META_EVENT_ID = window.dataLayer[i].event_id;
          return;
        }
      }

      window.META_EVENT_ID = generateEventId();
      window.dataLayer.push({
        event: 'meta_event_id_ready',
        event_id: window.META_EVENT_ID,
      });
    }

    initEventId();

    // Suporte a View Transitions do Astro (se houver)
    document.addEventListener('astro:page-load', initEventId);
  })();
</script>
```

**Por que assim:**
- Roda no `<head>` antes de tudo → garante que `event_id` existe quando GTM e Pixel disparam
- Empurra para `dataLayer` → GTM consegue ler via Data Layer Variable `Event ID`
- Expõe em `window.META_EVENT_ID` → script do form lê direto, sem racing

---

## Passo 2 — Layout global

Em `src/layouts/Layout.astro`, garantir esta ordem no `<head>`:

```astro
---
import MetaEventId from '../components/MetaEventId.astro';
---

<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <!-- 1º: gera event_id ANTES de qualquer outra coisa -->
  <MetaEventId />

  <!-- 2º: Usercentrics (ou outra CMP) -->
  <script id="usercentrics-cmp" data-settings-id="SEU_SETTINGS_ID"
          src="https://app.usercentrics.eu/browser-ui/latest/loader.js" async></script>

  <!-- 3º: GTM (gerenciado por consent quando aplicável) -->
  <script type="application/javascript">
    (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
    new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    })(window,document,'script','dataLayer','GTM-XXXXXX');
  </script>

  <!-- demais tags... -->
</head>
```

---

## Passo 3 — Script do formulário (com hash SHA-256 client side)

Criar em `src/components/FormScript.astro` e incluir nas páginas com formulário.

```astro
---
// FormScript.astro
---

<script is:inline>
(function () {
  var WEBHOOK_URL = 'https://webhook.SEU_DOMINIO.com/webhook/site-forms';

  // ── Hash SHA-256 via Web Crypto API ────────────────────────────
  async function sha256(value) {
    var normalized = (value || '').toLowerCase().trim();
    if (!normalized) return '';
    var encoded = new TextEncoder().encode(normalized);
    var buffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  // Telefone: normaliza para E.164 (só dígitos + sem o '+')
  function normalizePhone(phone) {
    var cleaned = (phone || '').trim().replace(/[\s\-().]/g, '');
    cleaned = cleaned.replace(/^\+/, '');
    return cleaned;
  }

  // ── Cookies ────────────────────────────────────────────────────
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  function getFbp() {
    return getCookie('_fbp');
  }

  // fbc: tenta cookie, senão reconstrói no formato fb.1.{ts}.{fbclid}
  function getFbc() {
    var cookieFbc = getCookie('_fbc');
    if (cookieFbc) return cookieFbc;

    var match = window.location.search.match(/[?&]fbclid=([^&]+)/);
    if (match) {
      return 'fb.1.' + Date.now() + '.' + decodeURIComponent(match[1]);
    }
    return '';
  }

  // ── Consent (Usercentrics) ─────────────────────────────────────
  function getMarketingConsent() {
    try {
      if (window.UC_UI && window.UC_UI.getServicesBaseInfo) {
        var services = window.UC_UI.getServicesBaseInfo();
        var fb = services.find(function(s) {
          return s.name && s.name.toLowerCase().indexOf('facebook') !== -1;
        });
        return fb ? fb.consent.status : false;
      }
    } catch (e) {}
    return false;
  }

  // ── UTMs e parâmetros de URL ───────────────────────────────────
  function getUrlParams() {
    var params = {};
    var search = window.location.search.substring(1);
    if (!search) return params;
    search.split('&').forEach(function(pair) {
      var idx = pair.indexOf('=');
      if (idx === -1) return;
      var k = decodeURIComponent(pair.slice(0, idx));
      var v = decodeURIComponent(pair.slice(idx + 1));
      params[k] = v;
    });
    return params;
  }

  // ── Submit ─────────────────────────────────────────────────────
  async function submitForm(formData) {
    // formData = { firstName, lastName, email, phone, ...campos custom }

    var eventId = window.META_EVENT_ID || (Date.now() + '_' + Math.floor(Math.random() * 1e15));

    // Hashes (client side para o Pixel via GTM)
    var emHash = await sha256(formData.email);
    var phHash = await sha256(normalizePhone(formData.phone));
    var fnHash = await sha256(formData.firstName);
    var lnHash = await sha256(formData.lastName);

    var fbp = getFbp();
    var fbc = getFbc();
    var consent = getMarketingConsent();

    // 1) Push para dataLayer → GTM dispara FBA Lead (Pixel browser)
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'meta_user_data_ready',
      event_id: eventId,
      em: emHash,
      ph: phHash,
      fn: fnHash,
      ln: lnHash,
      fbp: fbp,
      fbc: fbc,
    });

    // 2) POST para n8n (server side fará o CAPI)
    var payload = {
      // Dados do lead (em texto puro, n8n usa para CRM e re-hash se preciso)
      first_name: formData.firstName,
      last_name: formData.lastName,
      email: formData.email,
      phone: formData.phone,

      // Hashes prontos (n8n usa direto no CAPI)
      meta_event_id: eventId,
      meta_em: emHash,
      meta_ph: phHash,
      meta_fn: fnHash,
      meta_ln: lnHash,
      meta_fbp: fbp,
      meta_fbc: fbc,

      // Contexto
      meta_user_agent: navigator.userAgent,
      meta_event_source_url: window.location.href,
      submitted_at: new Date().toISOString(),
      marketing_consent: consent,
      url_params: getUrlParams(),
    };

    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('Webhook failed', err);
    }
  }

  // Expor globalmente para o form chamar
  window.submitMetaForm = submitForm;
})();
</script>
```

**Pontos críticos:**

1. **Normalização antes do hash** é obrigatória: lowercase + trim para e-mail/nome; só dígitos para telefone (sem `+`, espaços, hífens, parênteses)
2. **`meta_user_data_ready`** é o acionador da tag FBA Lead no GTM (NÃO usar `form_submit` — os hashes ainda não estão prontos)
3. **`fbc` reconstruído** quando o cookie não existe mas há `fbclid` na URL — formato `fb.1.{timestamp_ms}.{fbclid}`
4. **Não usar a variável `{{fbclid}}` na tag FBA Lead** — sempre usar `fbc` formatado

---

## Passo 4 — Configuração GTM

### 4.1 Variáveis a criar

| Nome | Tipo | Configuração |
|---|---|---|
| `Event ID` | Variável da Camada de Dados | Nome: `event_id` / Versão 2 |
| `em` | Variável da Camada de Dados | Nome: `em` |
| `ph` | Variável da Camada de Dados | Nome: `ph` |
| `fn` | Variável da Camada de Dados | Nome: `fn` |
| `ln` | Variável da Camada de Dados | Nome: `ln` |
| `fbp` | Cookie de 1ª Parte | Nome do cookie: `_fbp` |
| `fbc_formatted` | JavaScript Personalizado | (código abaixo) |

### 4.2 Código da variável `fbc_formatted`

```javascript
function() {
  var cookies = {};
  document.cookie.split(';').forEach(function(c) {
    var i = c.indexOf('=');
    if (i === -1) return;
    var k = c.slice(0, i).trim();
    var v = c.slice(i + 1).trim();
    try { cookies[k] = decodeURIComponent(v); }
    catch(e) { cookies[k] = v; }
  });
  if (cookies._fbc) return cookies._fbc;
  var match = window.location.search.match(/[?&]fbclid=([^&]+)/);
  if (match) return 'fb.1.' + Date.now() + '.' + match[1];
  return undefined;
}
```

### 4.3 Acionador

| Nome | Tipo | Configuração |
|---|---|---|
| `meta_user_data_ready` | Evento Personalizado | Nome do evento: `meta_user_data_ready` / Condição: Page URL contém o domínio de produção |

### 4.4 Tag `FBA Lead`

- **Tipo:** Facebook Pixel — Lead (ou Custom Event)
- **Acionador:** `meta_user_data_ready`
- **Object Properties:**

| Property | Value |
|---|---|
| `event_id` | `{{Event ID}}` |
| `fbc` | `{{fbc_formatted}}` |
| `fbp` | `{{fbp}}` |
| `em` | `{{em}}` |
| `ph` | `{{ph}}` |
| `fn` | `{{fn}}` |
| `ln` | `{{ln}}` |

### 4.5 Tags a NÃO criar / a deletar

- ❌ **Tag de "Data Layer Push event id"** — não criar. O `MetaEventId.astro` já é a fonte única. Criar essa tag causa race condition.
- ❌ Não usar variável `{{fbclid}}` bruta na tag FBA Lead — sempre `{{fbc_formatted}}`

---

## Passo 5 — Workflow n8n (server side CAPI)

### 5.1 Estrutura do workflow

```
Webhook (POST /site-forms)
  → IF marketing_consent === true
       ├── true: continua para CAPI
       └── false: pula CAPI, só salva no CRM (compliance GDPR)
  → Function: enriquece com IP do header
  → CRM (Zoho/HubSpot/etc): cria lead com campos custom Meta_*
  → HTTP Request: POST CAPI Meta
  → Response webhook
```

### 5.2 Node Function — capturar IP e formatar fbc fallback

```javascript
// Node "Set context" — antes do CAPI
const headers = $input.first().json.headers || {};
const body = $input.first().json.body || $input.first().json;

// IP do cliente (Cloudflare ou proxy padrão)
const clientIp = headers['cf-connecting-ip']
  || (headers['x-forwarded-for'] || '').split(',')[0].trim()
  || headers['x-real-ip']
  || '';

// Fallback fbc no servidor se não veio do client
const fbclid = body.url_params?.fbclid;
let fbc = body.meta_fbc;
if (!fbc && fbclid) {
  fbc = `fb.1.${Date.parse(body.submitted_at)}.${fbclid}`;
}

return {
  ...body,
  client_ip_address: clientIp,
  meta_fbc: fbc || '',
};
```

### 5.3 Node HTTP Request — Meta CAPI

- **URL:** `https://graph.facebook.com/v21.0/{{ $env.META_PIXEL_ID }}/events`
- **Method:** POST
- **Query Parameters:** `access_token` = `{{ $env.META_ACCESS_TOKEN }}`
- **Body (JSON):**

```json
{
  "data": [{
    "event_name": "Lead",
    "event_time": {{ Math.floor(Date.parse($json.submitted_at) / 1000) }},
    "event_id": "{{ $json.meta_event_id }}",
    "action_source": "website",
    "event_source_url": "{{ $json.meta_event_source_url }}",
    "user_data": {
      "em": ["{{ $json.meta_em }}"],
      "ph": ["{{ $json.meta_ph }}"],
      "fn": ["{{ $json.meta_fn }}"],
      "ln": ["{{ $json.meta_ln }}"],
      "external_id": ["{{ $json.meta_event_id }}"],
      "fbp": "{{ $json.meta_fbp }}",
      "fbc": "{{ $json.meta_fbc }}",
      "client_ip_address": "{{ $json.client_ip_address }}",
      "client_user_agent": "{{ $json.meta_user_agent }}"
    }
  }]
}
```

**Validações esperadas no response:**
- `events_received: 1` ✅
- `messages: []` ✅
- Sem erros de hash inválido

---

## Passo 6 — Variáveis de ambiente

Criar `.env.example` na raiz do projeto:

```bash
# Meta
META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=

# Webhook n8n
PUBLIC_WEBHOOK_URL=

# GTM
PUBLIC_GTM_ID=

# Usercentrics
PUBLIC_USERCENTRICS_SETTINGS_ID=
```

E referenciar via `import.meta.env.PUBLIC_*` nos componentes Astro (variáveis com prefixo `PUBLIC_` são expostas ao browser).

---

## Passo 7 — Compliance GDPR (DACH)

> ⚠️ **CRÍTICO** se o site atende Alemanha/Áustria/Suíça. Não pular.

Implementar no n8n um **gate de consent** antes do CAPI:

```
IF marketing_consent === true
  → dispara CAPI normalmente
ELSE
  → não envia para CAPI
  → salva no CRM com flag "consent_denied"
```

**Justificativa:** mesmo que o CAPI server side tecnicamente "ignore" o consent do browser, GDPR exige consentimento para a finalidade "marketing" independente do canal. Multas BfDI (regulador alemão) são pesadas.

**Alternativa para não perder atribuição:** Meta Consent Mode v2 + Conversions Modeling — envia o evento marcando `data_processing_options` e o algoritmo do Meta modela as lacunas. Considerar para v2.

---

## Passo 8 — Checklist de validação

### 8.1 Client side (DevTools + Tag Assistant)

- [ ] No console: `window.dataLayer.filter(e => e.event_id)` retorna **uma** entrada com `event_id` no formato `{timestamp}_{random}` (sem prefixo `fallback_`)
- [ ] No console: `window.META_EVENT_ID` tem valor preenchido
- [ ] Tag Assistant mostra a tag `FBA Lead` disparando no evento `meta_user_data_ready` (não no `form_submit`)
- [ ] `event_id` na tag FBA Lead é igual ao do payload enviado para o n8n
- [ ] `fbc` no formato `fb.1.{timestamp}.{fbclid}` (não fbclid bruto)
- [ ] `fbp` presente no formato `fb.1.{ts}.{random}`
- [ ] `em`, `ph`, `fn`, `ln` com 64 caracteres hexadecimais

### 8.2 Server side (n8n + Meta)

- [ ] `meta_event_id` no payload n8n igual ao `event_id` do GTM
- [ ] `meta_em`, `meta_ph`, `meta_fn`, `meta_ln` com 64 chars hex
- [ ] `meta_fbc` no formato correto
- [ ] `client_ip_address` preenchido (não vazio)
- [ ] Response do CAPI: `{"events_received": 1}` e sem mensagens de erro
- [ ] Em Events Manager → Test Events: aparece **Browser** e **Server** sendo deduplicados (não dois eventos separados)

### 8.3 URL de teste

```
https://growthroom.eu//lp?fbclid=IwAR3_TEST_FBCLID_123456&utm_source=facebook&utm_medium=paid&utm_campaign=test_capi_dedup&utm_content=variante_a
```

---

## Passo 9 — Estrutura de arquivos esperada

```
src/
├── components/
│   ├── MetaEventId.astro       ← Passo 1
│   └── FormScript.astro         ← Passo 3
├── layouts/
│   └── Layout.astro             ← Passo 2
└── pages/
    └── lp.astro                 ← inclui FormScript

.env.example                     ← Passo 6
README.md                        ← documentar setup do n8n e GTM
```

---

## Troubleshooting (sintomas comuns)

| Sintoma | Causa provável | Correção |
|---|---|---|
| `event_id` com prefixo `fallback_` | Script Astro não carregou antes do form | Verificar ordem no `<head>` — `MetaEventId` deve vir primeiro |
| Browser e server contam como 2 eventos no Meta | `event_id` divergente entre Pixel e CAPI | Confirmar que GTM lê `{{Event ID}}` da dataLayer e n8n usa `meta_event_id` do payload |
| EMQ baixo (< 6) | `client_ip_address` vazio ou hashes errados | Conferir captura de IP no n8n e normalização antes do hash |
| Tag FBA Lead dispara mas `em`, `ph` chegam vazios | Acionador é `form_submit` em vez de `meta_user_data_ready` | Trocar acionador no GTM |
| `fbc` rejeitado pelo Meta | Está enviando `fbclid` bruto em vez de `fb.1.{ts}.{fbclid}` | Usar variável `fbc_formatted` no GTM e `getFbc()` no script |
| Leads sumindo no Meta mas chegando no CRM | Consent denied → CAPI não disparou (correto sob GDPR) | Verificar flag `consent_denied` no CRM; se confirmado, é compliance |
| `events_received: 0` no response CAPI | Access token expirado ou Pixel ID errado | Regenerar token em Events Manager |

---

## Referências

- Meta Conversions API: https://developers.facebook.com/docs/marketing-api/conversions-api
- Event Deduplication: https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
- Customer Information Parameters (hash format): https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
- GTM Data Layer: https://developers.google.com/tag-platform/tag-manager/datalayer

---

## Resumo do que o Claude Code deve entregar

1. ✅ Componente `MetaEventId.astro` no `<head>` global
2. ✅ Script de form com SHA-256 client side, `fbp`/`fbc` e push correto para dataLayer
3. ✅ Webhook POST para n8n com payload completo (incluindo IP via header e consent)
4. ✅ `.env.example` com todas as variáveis necessárias
5. ✅ README com instruções para configurar GTM (variáveis, acionador, tag FBA Lead)
6. ✅ README com estrutura do workflow n8n (sem precisar implementar — só documentar o que cliente precisa montar)
7. ✅ URL de teste e checklist de validação
```