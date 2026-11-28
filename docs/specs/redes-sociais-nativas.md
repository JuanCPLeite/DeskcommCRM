# Redes sociais nativas

## Escopo

`Conexões → Redes sociais` conecta um perfil Zernio à organização. Contas e
redes são lidas da API; autorização usa o fluxo hospedado do provedor e retorna
à mesma aba. Instagram e Facebook recebem DMs na caixa de entrada existente.
Outras redes podem ser autorizadas e verificadas, mas não são apresentadas como
canais de atendimento. Publicação, anúncios e comentários não fazem parte desta
entrega. Contas de anúncios são filtradas da lista.

## Segurança e dados

- `channel_integrations` guarda a credencial cifrada e o perfil por organização.
  Só `service_role` acessa a tabela; API exige administrador e MFA quando cadastrado.
- As chamadas externas usam timeout, resposta sem cache e recusa de redirects.
- Sessões de atendimento usam `zernio_social`, sem mudar o transporte WhatsApp.
- `contacts.social_identity` é rede/conta/participante; nunca vira telefone ou LID.
- Webhook exige assinatura antes de arquivar ou ingerir. Conta e rede precisam
  corresponder à sessão. IDs de mensagem incluem a conta para deduplicação.
- A API não devolve a chave; auditoria registra apenas a operação, sem credenciais.
- Cada sessão recebe um webhook próprio. Uma tentativa incerta é reconciliada
  por URL antes de criar outra assinatura. Falha deixa o canal visível para retentar.

## Entrada e saída

`webhooks/channel/[token] → social/ingest → zernio/ingest → pos-entrada` reutiliza
mensagens, lead, opt-out, fila de agentes e pausa por atendimento externo.
`socialAdapter → inbox/conversations/{id}/messages` exige a thread do provedor;
confirmação sem `messageId` é falha, nunca um envio declarado como concluído.

Instagram/Facebook respeitam a janela de 24 horas existente. Não têm templates
WhatsApp. Anexos do provedor recebem Bearer apenas no domínio e caminho da API;
CDNs nunca recebem essa chave e redirects de mídia são recusados.

## Operação

Canais novos ficam com IA pausada (`pre_go_live`, lista vazia). O administrador
pode liberar ou pausar pela tela, depois de vincular um agente e avaliar se outra
automação já responde à conta. Nenhum webhook externo é desativado pela conexão.
Histórico anterior não é importado nem reprocessado automaticamente.

### As duas chaves (spec 22, D1)

A chave do perfil (`channel_integrations`) é gerenciar; cada canal social guarda
uma cópia (`channel_sessions.zernio_token_encrypted`) para os fundos, com o env
como fallback. Salvar a credencial na tela reescreve a cópia em TODOS os canais
do perfil — inclusive os arquivados, que podem voltar. Quando a chave troca no
provedor, reconfigurar com a chave certa ressincroniza tudo; nenhuma sessão
velha prende a faixa. Conta removida e recriada no provedor ganha `accountId`
novo: a linha velha aparece em `orphaned_channels` do GET e a tela oferece
Excluir. Trocar de perfil exige desvincular o antigo, e desvincular exige zero
canais ativos.

## Sistema vivo

Entrada: contas autorizadas e webhook assinado. Saída: Inbox, mensagens e motor
existente de atendimento. Porta: aba em Conexões. Registro: auditoria de mudança,
arquivo de webhook, ledger de mensagens. Recuperação: falha visível e retentativa
com reconciliação. Retorno: erro do provedor impede declarar envio; mensagens
externas pausam a IA, opt-out impede novas respostas. Saúde passa pelo vigia existente.

## Fontes verificadas

- https://docs.zernio.com/accounts/list-accounts
- https://docs.zernio.com/connect/get-connect-url
- https://docs.zernio.com/webhooks/create-webhook-settings
- https://docs.zernio.com/messages/list-inbox-conversations

## Validação de 2026-09-15

- Suíte unitária completa: 858 arquivos, 8.807 testes aprovados e uma falha esperada.
- Banco: instalação e atualização do baseline; 55 invariantes dirigidos aprovados
  (incluindo RLS e isolamento da nova tabela), após a varredura completa.
- QA com Postgres/Supabase e HTTP locais: configurar perfil, ativar conta, verificar
  saúde, ingerir mensagem assinada, repetir evento, recusar assinatura inválida e
  ignorar outra conta antes de arquivar. Resposta humana passou pelo handler real
  e chegou ao servidor de transporte de teste com a thread correta.
- Navegador real: aba Redes sociais, diagnóstico de conexão, permissões de IA e
  conversa com entrada/saída no Inbox. Identificador numérico permaneceu sem telefone.
- Publicação e entrega real no provedor são verificações separadas do QA local.

## Conexão direta pela Meta (Instagram) — Fase 1

Além do provedor intermediário, o Instagram pode ser conectado **direto pelo app Meta da instalação**
(login unificado), como canal próprio (`meta_social`). Desenho completo em
`docs/superpowers/specs/2026-11-27-instagram-facebook-nativos-design.md`; o que existe na Fase 1:

- **Credenciais do app** na instalação (`platform_meta_social_app`, só servidor), em `/admin/meta-social`;
  o `.env` (`META_SOCIAL_*`) é o piso de rollback.
- **Conexão** em Conexões › Instagram. A volta do login passa pela ponte pública
  `/auth/meta-social-return` (o cookie Strict não viaja) e é concluída pela tela, autenticada
  (`POST /api/v1/channels/meta-social`). Uma conta ativa pertence a UMA organização.
- **Webhook único por app** em `/api/v1/webhooks/meta-social`: assinatura (HMAC SHA-256 da chave do app)
  antes de qualquer escrita; a organização vem da conta que recebeu, nunca do corpo. Conta desconhecida e
  comentário respondem 200 (sem tratamento ainda); falha de ingestão responde 500 para a Meta reentregar.
- **Entrada** reaproveita a ingestão social (`ingestZernioInbound` com `socialMessage`): contato por
  `instagram:<conta>:<participante>`, idempotência por `external_id`, opt-out e pós-entrada. **Saída**
  pelo adaptador, com a janela de 24 h e falhas classificadas (permanente/transitória).
- **Segurança**: token cifrado por sessão; a ligação (`social_account_id`, token) só é gravada pelo
  servidor (gatilho estendido); desconectar zera o token e desfaz a assinatura na Meta (best-effort).
- **Fora desta fase**: comentários, fluxos, Live, Story, Facebook, testadores da IA por conta (o
  portão exige o formato de conta do provedor intermediário), App Review/Tech Provider.
