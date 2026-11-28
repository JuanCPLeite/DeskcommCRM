# Instagram nativo — Fase 1 (canal, conexão, webhook, DM na Inbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar uma conta Instagram pelo app Meta próprio (login unificado), receber DMs por webhook assinado, vê-las na Inbox e responder por ela, respeitando a janela de 24 h.

**Architecture:** Novo provider de mensagem `meta_social`, ao lado de `zernio_social` (que não é removido). Um webhook único por app Meta (`/api/v1/webhooks/meta-social`), com assinatura pela chave do app; a organização é resolvida pelo `channel_sessions.social_account_id` (único), nunca pelo corpo. A entrada reaproveita a ingestão social existente (contato, conversa, mensagem, opt-out, pós-entrada) por um núcleo extraído, sem copiá-la.

**Tech Stack:** Next.js 16 Route Handlers, Supabase/Postgres (RLS), Zod, Vitest, Graph API da Meta (v25.0).

**Spec:** `docs/superpowers/specs/2026-11-27-instagram-facebook-nativos-design.md`

## Global Constraints

- Branch `feat/meta-social-nativo`, criada de `origin/main`. Migrations **NNNN 9513 (o próximo livre medido por `pnpm checar:colisao-de-migration`, que conta os PRs abertos do projeto)** (9452 e 9453 estão em `feat/tech-provider-embedded-signup`); conferir com `pnpm checar:colisao-de-migration` antes de commitar.
- Migration: `-- manifest:` na 1ª linha, idempotente, sem `BEGIN/COMMIT`, **apêndice no `supabase/baseline.sql`** (um bloco por constraint), `revoke ... from public, anon` em função nova, `notify pgrst, 'reload schema'` no fim.
- Tabela tenant-aware: `organization_id uuid not null references organizations(id) on delete cascade` + RLS `fn_user_org_ids()` + teste de isolamento. Credencial: tabela "só servidor" (RLS ligada, sem policy, grant só a `service_role`).
- Nenhuma feature nomeia provider: só `lib/channels/**` conhece `meta_social` (`pnpm lint:channels`). Capability nova só se alguém a consome.
- Tokens e chaves **cifrados** (`encryptWebhookSecret`/`decryptWebhookSecret` de `lib/webhooks/secrets.ts`), nunca em resposta de API nem em log. Chave do app **nunca** em query string.
- Idempotência: `unique (organization_id, external_id)`; `external_id = social:<conta>:<mid>` (`socialMessageId`). Trigger não faz HTTP.
- Rotas mutantes: `requireRole("admin")`, `requireSupportWrite(`, `mfaEmDivida()`, auditoria sem credencial, wrapper `ok()/fail()`.
- Canal novo nasce com IA pausada (`metadataInicialDoCanal`, `pre_go_live`).
- Graph API: `META_GRAPH_API_VERSION` com padrão `v25.0`. Textos de tela em pt-BR com acentos.
- Definition of Done do `CLAUDE.md`: typecheck, lint, `lint:channels`, `pnpm test:unit` (sem caminho), `pnpm test:db`, fragmento em `.changes/`, destino declarado (**núcleo**), prova pela tela.

## Passos manuais do dono (fora do código)

1. No painel do app Meta (DMFLOW): **URIs de redirecionamento do OAuth válidos** (Login do Facebook) e **URL de redirecionamento** (Instagram API, login unificado) ganham `https://<domínio do CRM>/auth/meta-social-return`.
2. **Webhooks → Instagram**: URL `https://<domínio do CRM>/api/v1/webhooks/meta-social`, token = o "token de verificação" salvo na tela de credenciais do CRM; campos `messages`, `messaging_postbacks`, `comments`, `live_comments`.
3. Conta Instagram de teste como **Testador do Instagram** (já feito para o DMFlow).

## Review Focus

1. Webhook de conta que **nenhuma organização** conectou → 200 e nada gravado (a Meta reenvia em loop se receber erro).
2. A mesma entrega repetida pela Meta → uma só mensagem.
3. Assinatura inválida ou ausente → 401, nada arquivado como válido.
4. **Eco**: a DM que o próprio CRM enviou volta pelo webhook (`is_echo`) → não vira mensagem recebida nem dispara a IA.
5. A mesma conta Instagram conectada por duas organizações → a segunda é recusada.
6. Evento de comentário chegando na Fase 1 (campo já assinado) → 200 e ignorado, sem erro.

---

### Task 1: Provider `meta_social` na matriz de canais

**Files:**
- Modify: `lib/channels/types.ts:19` (união `ChannelProvider`), `lib/channels/capabilities.ts` (`CHANNEL_CAPABILITIES`, `PROVIDERS_DE_MENSAGEM`, `PROVIDERS_DE_TELEFONE`, `PROVIDERS_SEM_CAMPANHA`, constante `CHANNEL_PROVIDER_META_SOCIAL`), `lib/channels/index.ts` (`ADAPTERS`), `lib/channels/templates-fonte.ts` (`FONTE`), `lib/channels/session-ref.ts` (união `ChannelSessionRef` + `resolveSessionRef`), `lib/channels/presentation.ts` (`channelBrand`), `lib/channels/inbound.ts` (`acceptsInboundWebhook`), `lib/channels/social/porta.ts` (porta `direta` passa a `implementada: true`, `providerNoBanco: "meta_social"`).
- Test: `tests/unit/channel-capability-matrix.test.ts`, `tests/unit/redes-sociais-pelo-modelo-neutro.test.ts` (estender).

**Interfaces:**
- Produces: `ChannelProvider` inclui `"meta_social"`; `capabilitiesOf("meta_social")` = mesmas capacidades de `zernio_social` (`freeformOutsideWindow:false`, `requiresTemplates:false`, `banRisk:false`, `voiceNote:"none"`); `ChannelSessionRef` ganha `{provider:"meta_social"; social_account_id: string}`; `channelBrand` devolve `instagram`/`messenger` pelo `metadata.social_platform`.

- [ ] **Step 1:** Estender os testes de matriz e de modelo neutro para exigir a linha `meta_social` (capacidades iguais às de `zernio_social`, marca derivada de `social_platform`, `resolveSessionRef` devolve `social_account_id`). Rodar `pnpm vitest run tests/unit/channel-capability-matrix.test.ts tests/unit/redes-sociais-pelo-modelo-neutro.test.ts` — esperado: FAIL (valor desconhecido).
- [ ] **Step 2:** Adicionar o valor à união e a cada `Record` exaustivo listado em Files (o compilador aponta os que faltarem). `ADAPTERS.meta_social` aponta para o adaptador da Task 7; até lá, `null` com comentário.
- [ ] **Step 3:** `pnpm typecheck` e os dois testes — esperado: PASS. `pnpm lint:channels` — PASS.
- [ ] **Step 4:** Commit `feat(canais): provider meta_social na matriz de canais`.

### Task 2: Migration 9513 — sessão do canal, credenciais do app e baseline

**Files:**
- Create: `supabase/migrations/<timestamp>_9513_meta_social_canal.sql`
- Modify: `supabase/baseline.sql` (apêndice no fim), `lib/database.types.ts` (regenerar)
- Test: `tests/invariants/meta-social-isolamento.test.ts`

**Interfaces:**
- Produces (banco):
  - `channel_sessions.provider` aceita `'meta_social'` (reescrever `channel_sessions_provider_check` e `channel_sessions_provider_ref_check` em **um bloco** cada).
  - `channel_sessions.social_account_id text` + `meta_social_token_encrypted text` + `meta_social_token_expires_at timestamptz`; índice **único parcial** em `social_account_id where provider = 'meta_social' and archived_at is null`.
  - Tabela `platform_meta_social_app` (singleton `id smallint primary key check (id = 1)`): `app_id text`, `login_config_id text`, `app_secret_encrypted text`, `verify_token_encrypted text`, `updated_at`. RLS ligada, sem policy, só `service_role`.
  - `ref_check`: `(provider = 'meta_social' and social_account_id is not null)`.

- [ ] **Step 1:** Escrever o teste de invariante: com duas organizações, uma sessão `meta_social` de cada; a de A não é lida pela role de B; inserir a mesma `social_account_id` ativa em duas orgs falha (índice único); `platform_meta_social_app` é ilegível por `authenticated`/`anon`. Rodar `pnpm test:db tests/invariants/meta-social-isolamento.test.ts` — esperado: FAIL.
- [ ] **Step 2:** Escrever a migration (conferir o NNNN com `pnpm checar:colisao-de-migration`) e o **apêndice idempotente** no baseline, preservando os valores já aceitos de `provider` (`waha, meta_cloud, zernio, wacalls, zernio_social, datafy, telegram`) e os pares do `ref_check` existentes.
- [ ] **Step 3:** `pnpm test:db` completo (install e update do baseline) — esperado: PASS. Regenerar `lib/database.types.ts`.
- [ ] **Step 4:** Commit `feat(canais): schema do canal Meta social e credenciais do app`.

### Task 3: Credenciais do app Meta social (instalação)

**Files:**
- Create: `lib/channels/meta-social/app.ts`, `lib/channels/meta-social/app.test.ts`, `app/admin/(protected)/meta-social/page.tsx`, `app/admin/(protected)/meta-social/_form.tsx`, `app/actions/settings/updateMetaSocialApp.ts`
- Modify: `lib/navigation/catalogo.ts` ou a navegação do admin conforme o padrão da tela `meta/` existente

**Interfaces:**
- Produces: `appSocialDaMeta(): Promise<{ appId: string|null; loginConfigId: string|null; appSecret: string|null; verifyToken: string|null }>` (nunca lança; banco primeiro, `.env` `META_SOCIAL_APP_ID`/`META_SOCIAL_LOGIN_CONFIG_ID`/`META_SOCIAL_APP_SECRET`/`META_SOCIAL_VERIFY_TOKEN` como piso; cache curto); `invalidarAppSocialDaMeta(): void`; `salvarAppSocialDaMeta(admin, input): Promise<void>` (chave secreta vazia = manter).

- [ ] **Step 1:** Testes de `appSocialDaMeta`: banco vence o `.env`; sem banco cai no `.env`; banco ilegível não lança; chave secreta nunca aparece no retorno de `fontes`.
- [ ] **Step 2:** Implementar o módulo seguindo o formato de `lib/channels/meta/app.ts`. Rodar os testes — PASS.
- [ ] **Step 3:** Tela admin + action espelhando `app/admin/(protected)/meta/` (plataforma-admin apenas, MFA quando cadastrado, auditoria sem segredo); mostra o **token de verificação** (gerado se vazio) e as duas URLs a colar no painel da Meta.
- [ ] **Step 4:** Commit `feat(canais): credenciais do app Meta social na instalação`.

### Task 4: Conexão por login unificado (OAuth)

**Files:**
- Create: `lib/channels/meta-social/oauth.ts`, `lib/channels/meta-social/oauth.test.ts`, `lib/channels/meta-social/graph.ts`, `app/api/v1/channels/meta-social/connect/route.ts`, `app/auth/meta-social-return/route.ts` (+ testes de rota)

**Interfaces:**
- Produces:
  - `criarEstadoOAuth(input: { organizationId: string; userId: string }): string` / `verificarEstadoOAuth(state: string | null): { organizationId: string; userId: string } | null` (HMAC com segredo do servidor, validade 10 min, `timingSafeEqual`).
  - `urlDeAutorizacao(app, redirectUri, state): string` → `https://www.facebook.com/dialog/oauth?client_id&config_id&redirect_uri&response_type=code&state` (`prompt=login`).
  - `trocarCodigo(app, code, redirectUri): Promise<{ accessToken: string }>`; `contasAtribuidas(token): Promise<{id:string; username?:string}[]>` (`/me/assigned_instagram_accounts`); `perfilDaConta(token, igId)`; `assinarWebhooks(token, igId)` (`subscribed_apps`, campos `messages,messaging_postbacks,comments,live_comments`).
  - Rotas: `GET connect` → 302 para a Meta; `GET callback` → cria/atualiza `channel_sessions` (`provider:'meta_social'`, `social_account_id`, token cifrado, `metadata.social_platform:'instagram'`, `metadataInicialDoCanal`), recusa conta já conectada em **outra** organização, grava auditoria sem token, volta para `/app/connections?aba=meta-social&ok=1|erro=<código>`.

- [ ] **Step 1:** Testes do estado (assinatura inválida, expirado, futuro, payload não numérico) e da URL de autorização (contém `config_id`, não contém segredo). FAIL → implementar → PASS.
- [ ] **Step 2:** Teste da rota `callback` com `fetch` simulado: caminho feliz grava sessão com IA pausada; conta já ligada a outra organização é recusada (Review Focus 5); troca de código falha → volta com `erro` e **nada** gravado. Implementar → PASS.
- [ ] **Step 3:** Commit `feat(canais): conectar Instagram pelo login unificado da Meta`.

### Task 5: Webhook da Meta para Instagram (verificação, assinatura, parse)

**Files:**
- Create: `app/api/v1/webhooks/meta-social/route.ts`, `app/api/v1/webhooks/meta-social/route.test.ts`, `lib/channels/meta-social/webhook.ts`, `lib/channels/meta-social/webhook.test.ts`
- Modify: `lib/channels/inbound.ts` (ponto de entrada compartilhado, se necessário), arquivo do webhook (`abrirArquivoDoWebhook`)

**Interfaces:**
- Consumes: `verifyMetaSignature(rawBody, header, appSecret)` e `verificationChallenge(searchParams, verifyToken)` de `lib/channels/meta/webhook.ts`; `appSocialDaMeta()` (Task 3).
- Produces: `parseMetaSocialWebhook(raw: unknown): MetaSocialEvento[]` com `MetaSocialEvento = { tipo: 'mensagem'|'eco'|'postback'|'comentario'|'outro'; contaId: string; participanteId: string; mid: string; texto: string|null; anexos: {tipo:string; url:string}[]; enviadoEm: Date; replyToStory?: string }`.
- Rota: `GET` devolve `hub.challenge` em `text/plain` (ou 403); `POST` verifica assinatura (401), arquiva em `webhook_events_log`, responde **sempre 200** a evento válido (ignorado quando a conta é desconhecida).

- [ ] **Step 1:** Testes de `parseMetaSocialWebhook` com payloads reais (mensagem de texto, anexo imagem, resposta a Story, `is_echo`, postback, evento de comentário → `tipo:'comentario'`, lixo → lista vazia sem lançar). FAIL → implementar → PASS.
- [ ] **Step 2:** Testes da rota: GET com token certo/errado; POST com assinatura inválida → 401 e nenhum registro; conta desconhecida → 200 `ignored` (Review Focus 1); comentário → 200 `ignored` (Review Focus 6). FAIL → implementar → PASS.
- [ ] **Step 3:** Commit `feat(canais): webhook da Meta para Instagram com assinatura`.

### Task 6: Núcleo de ingestão social compartilhado

**Files:**
- Modify: `lib/channels/zernio/ingest.ts` (extrair contato/conversa/mensagem/pós-entrada para função exportada), `lib/channels/social/ingest.ts`
- Create: `lib/channels/social/ingest-core.ts`, `lib/channels/meta-social/ingest.ts`, `lib/channels/meta-social/ingest.test.ts`
- Test: os testes existentes de `lib/channels/zernio/ingest*.test.ts` **continuam verdes** (rede de segurança da extração).

**Interfaces:**
- Produces: `ingestSocialCore(db, input: { organizationId: string; channelSessionId: string; plataforma: 'instagram'|'facebook'; participanteId: string; nome: string|null; externalId: string; direcao: 'in'|'out'; texto: string|null; anexos: ...; enviadoEm: Date; threadId: string }): Promise<{ status: 'ingested'|'duplicate'|'ignored'; conversationId?: string; messageId?: string; reason?: string }>` e `ingestMetaSocial(db, evento: MetaSocialEvento): Promise<mesmo tipo>` (resolve a sessão por `social_account_id`, chama `ingestSocialCore`).

- [ ] **Step 1:** Rodar a suíte `lib/channels/zernio` antes de mexer, para ter a linha de base. Esperado: verde.
- [ ] **Step 2:** Testes de `ingestMetaSocial`: mensagem nova cria contato (`contacts.social_identity` no mesmo formato que o Zernio usa, **sem virar telefone**), conversa e mensagem; mesma entrega duas vezes → `duplicate`, uma linha (Review Focus 2); `eco` não vira recebida e **não** aciona o pós-entrada (Review Focus 4); opt-out ("parar") é respeitado. FAIL.
- [ ] **Step 3:** Extrair `ingestSocialCore` sem mudar comportamento do Zernio (refatoração em passos pequenos; os testes existentes são o guarda). Implementar `ingestMetaSocial`. Tudo PASS.
- [ ] **Step 4:** Commit `refactor(canais): núcleo de ingestão social compartilhado` e `feat(canais): ingestão de DMs do Instagram direto`.

### Task 7: Adaptador de envio `metaSocialAdapter`

**Files:**
- Create: `lib/channels/meta-social/adapter.ts`, `lib/channels/meta-social/adapter.test.ts`
- Modify: `lib/channels/index.ts` (trocar o `null` da Task 1)

**Interfaces:**
- Produces: `metaSocialAdapter: ChannelAdapter` — `provider:'meta_social'`; `resolveRecipient: (input) => input.isGroup ? null : "provider-thread"`; `send(envelope)` faz `POST /{v}/{social_account_id}/messages` com `{ recipient:{id}, message:{text} }` (e anexos imagem/vídeo/áudio) usando o token da sessão; devolve `externalId: socialMessageId(conta, message_id)`; sem `message_id` → falha permanente; janela vencida → `FalhaDeEnvioDoCanal` permanente; `checkHealth` valida o token (`/me?fields=id`) e informa expiração; `fetchInboundMedia` só envia token ao host da Meta.

- [ ] **Step 1:** Testes com `fetch` simulado: envio de texto monta a URL/corpo certos e devolve `externalId`; resposta sem `message_id` lança permanente; token expirado (erro 190) vira falha permanente com código neutro; o token **nunca** aparece em mensagem de erro nem log. FAIL → implementar → PASS.
- [ ] **Step 2:** Teste de integração leve: envio pela Inbox (`app/api/v1/messages/_handler.ts`) escolhe o adaptador pela sessão `meta_social` e respeita `aJanelaRegulatoriaSeAplica`.
- [ ] **Step 3:** Commit `feat(canais): envio de DM do Instagram pelo adaptador Meta`.

### Task 8: Aba "Instagram" em Conexões

**Files:**
- Create: `app/api/v1/channels/meta-social/route.ts` (+ teste), `components/connections/MetaSocialClient.tsx`
- Modify: `components/connections/ConexoesShell.tsx` (nova `TabsTrigger`/`TabsContent` `meta-social`, estado na URL `?aba=`), `app/app/connections/page.tsx` (passa se o app está configurado)

**Interfaces:**
- Produces: `GET /api/v1/channels/meta-social` → `{ configured: boolean; accounts: { id; username; connected_at; token_expires_at; ia_pausada: boolean; health: 'ok'|'token_vencido'|'erro' }[] }` (sem token); `POST` `{ action: 'disconnect' | 'health', channel_id }` (admin + MFA + auditoria). Botão **Conectar Instagram** (`GET connect`) só aparece com o app configurado; sem ele mostra o que falta e o caminho da tela de credenciais.

- [ ] **Step 1:** Teste da rota (admin vê; agente recebe 403; resposta nunca contém token; `disconnect` arquiva a sessão e apaga o token). FAIL → implementar → PASS.
- [ ] **Step 2:** Componente da aba seguindo `RedesSociaisClient.tsx` (react-query, mesmas convenções de botões e responsividade). Estados vazio/erro/carregando.
- [ ] **Step 3:** Commit `feat(conexoes): aba Instagram para conectar contas pelo app Meta`.

### Task 9: Inbox, documentação, prova pela tela e fechamento

**Files:**
- Modify: `lib/channels/presentation.ts` (se faltar o selo), `docs/specs/redes-sociais-nativas.md` (seção "Conexão direta pela Meta"), `docs/testing/user-journey-map.md`, `.changes/instagram-direto-pela-meta.md`
- Create: `evidence/instagram-direto-fase-1/` (capturas)

- [ ] **Step 1:** Fragmento `.changes/`: `impacto: capacidade_nova`, `secao: adicionado`, título na voz de quem opera; `pnpm release:conferir`.
- [ ] **Step 2:** Atualizar a spec de redes sociais e o mapa de jornadas (a afirmação de estado sobre o que mudou).
- [ ] **Step 3:** Rodar a suíte completa: `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`, `pnpm test:unit` (sem caminho, exit code como autoridade), `pnpm test:db`.
- [ ] **Step 4:** **Prova pela tela** com a conta de teste real (ambiente com o app Meta configurado): conectar → enviar DM de outra conta → aparece na Inbox com selo → responder pela Inbox → chega no Instagram; repetir o webhook → sem duplicata. Registrar em `evidence/`.
- [ ] **Step 5:** PR com "O que NÃO medi", destino declarado (**núcleo**) e a pergunta da doutrina de extensões respondida. Push e PR são feitos com o dono.

---

## Auto-revisão

- **Cobertura da spec (Fase 1):** credenciais (T3), conexão em Conexões (T4, T8), webhook (T5), DM na Inbox (T6, T9), envio e janela de 24 h (T7), provider e matriz (T1), banco (T2). Comentários, fluxos, Live, Facebook e Tech Provider ficam para as Fases 2–5, por desenho.
- **Risco principal:** T6 (extrair o núcleo de `zernio/ingest.ts`, arquivo grande). Mitigação: linha de base verde antes, extração em passos, suíte do Zernio como guarda.
- **Pontos para o implementador confirmar no código (o mapa não leu):** formato exato de `contacts.social_identity`; assinatura de `lerEnvelopeMeta` para eventos de Instagram; `actionSchema`/navegação do admin; corpo de `messages/_handler.ts`.
- **Tamanho:** 9 tarefas, cada uma com entrega testável isolada.
