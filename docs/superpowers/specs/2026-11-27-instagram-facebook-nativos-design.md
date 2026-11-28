# Instagram e Facebook nativos (app Meta próprio) — design

Status: **rascunho para aprovação**. Nada foi construído. Autor: Claude, com o dono do produto.

## Intenção e porquê

Hoje Instagram/Facebook chegam ao CRM só pelo Zernio (DMs na Inbox, sem comentários). O dono do
produto quer **uma conexão direta com a Meta, pelo app Meta próprio da instalação**, desenhada para
virar **Tech Provider** (como já foi feito para o WhatsApp), e um **construtor de fluxos no formato
ManyChat atualizado**: o contato comenta, a automação responde o comentário, manda DM, e a conversa
aparece na Caixa de Entrada. O motivo: **um app só**, em vez de DMFlow (fork do OpenReply) ao lado do CRM.

O DMFlow (`dmflow.eagleapps.com.br`) fica como banco de teste e fonte de código MIT, e foi quem
validou o app Meta, o login unificado, o webhook e a conta de teste.

## Metas, não-metas, anti-metas

**Metas**
1. Conectar contas Instagram (e Páginas do Facebook) pelo app Meta próprio, em Conexões.
2. Receber comentários (post, Reel, Live), DMs, respostas a Story e menções.
3. Automação básica funcionando primeiro: comentou → responde o comentário → manda DM → etiqueta e cria lead.
4. Fluxos visuais de vários passos, com preview de celular.
5. Toda DM na Inbox única, ligada a contato, lead e funil.

**Não-metas (agora)**: publicar conteúdo, anúncios, App Review/Tech Provider em si (só o desenho), migrar o histórico do DMFlow.

**Anti-metas** (seria fracasso mesmo funcionando): um segundo cadastro de pessoas; um segundo motor de
automação paralelo ao do CRM; token de Instagram em texto puro; a Meta nomeada dentro de feature de negócio
fora da camada de canal (`restricao-de-canal.md`).

## Restrições da Meta (medidas no DMFlow e na documentação)

- Comentário → DM é uma **resposta privada**: uma por comentário, em até 7 dias; só continua se a pessoa responder.
- DM livre só dentro de **24 horas** da última mensagem da pessoa. Story, compartilhamento e menção abrem a janela.
- **Não existe webhook de "novo seguidor"**. "Segue?" é uma consulta na hora (condição do fluxo).
- Webhook assinado (`X-Hub-Signature-256`) com a chave do app; campos: `comments`, `live_comments`, `messages`, `messaging_postbacks`, `mentions`, `messaging_referral`.
- Apps novos só têm o **login unificado** (`config_id`): a conexão devolve um token de usuário de sistema e lista as contas atribuídas.

## Onde cada peça mora (o mapa)

| Peça | Lugar no CRM | Destino |
|---|---|---|
| Credenciais do app Meta (ID, config, chave, token do webhook) | Configurações da instalação, como `credentials-da-instalacao` do Zernio; chave cifrada | núcleo |
| Conectar contas e Páginas | **Conexões** (`/app/connections`), nova aba "Instagram e Facebook" | núcleo |
| Mensagens | **Inbox** existente, selo do canal, janela de 24 h pela matriz de capacidades | núcleo |
| Contato | `contacts.social_identity` (já existe), nunca vira telefone | núcleo |
| Comentários e o que a automação fez | Painel novo **Instagram** / **Facebook** (item de menu próprio) | núcleo |
| Gatilhos e ações sociais | **Motor de automações** existente (novos tipos) | núcleo |
| Editor visual de fluxos + preview de celular | Dentro do painel Instagram/Facebook | **módulo** ativável (a organização decide) |

Pergunta da doutrina de extensões: *se ninguém ativar os fluxos, a operação comum continua inteira?* — sim: conexão, Inbox, comentários e a automação simples seguem. Por isso o construtor de fluxos é módulo e o resto é núcleo (**minha decisão**, a confirmar).

## Abordagem escolhida

Três caminhos foram considerados: (1) fatia mínima sobre o motor de automações existente, com o editor visual crescendo depois; (2) construtor completo já, com motor próprio; (3) portar o OpenReply quase inteiro. **Escolhido: (1) com o editor de fluxos como Fase 3** — o dono pediu fluxo desde já, então ele entra no plano, mas sobre o mesmo motor, não ao lado dele. (2) duplica contatos, etiquetas e limites; (3) traz uma segunda base de pessoas.

## Modelo (resumo; DDL fica para o plano)

- Reuso: `channel_sessions` (novo `provider` social Meta), `contacts.social_identity`, mensagens/conversas, `event_log`.
- Novas tabelas, todas com `organization_id` + RLS `fn_user_org_ids()` + teste de isolamento:
  `social_comments` (único `organization_id, external_id`), `social_flows` (documento JSON de nós e arestas, versionado), `social_flow_runs` (estado por contato, nó atual, próxima execução).
- Tokens: cifrados, renovação por cron (60 dias), nunca em resposta de API.
- Esperas e reenvios: via `event_log` + worker/cron. **Trigger Postgres nunca faz HTTP.**
- Opt-out, pausa por atendimento humano e `pre_go_live` valem como nos outros canais (canal novo nasce com IA pausada).

## Automações

- Gatilhos: comentou (palavra-chave, post específico ou qualquer), comentou na Live, respondeu Story, mencionou em Story/comentário, DM com palavra-chave, clicou em botão, entrou por link `ig.me`.
- Condições: segue a conta?, palavra-chave, post, horário, etiqueta, campo.
- Ações: **responder o comentário** (várias variações), **resposta privada (DM)** com texto e botões, DM livre dentro da janela, etiquetar, criar/mover lead, tarefa, webhook, transferir para humano, IA.

## Fluxos visuais (Fase 3, módulo)

Documento de nós e arestas executado pelo motor; cada contato tem uma execução com o nó atual. Preview de
celular reaproveitado do DMFlow (peça de UI), com as regras da Meta mostradas no editor (janela, uma
resposta privada por comentário).

## Fases

| Fase | Entrega | Prova |
|---|---|---|
| 0 | Esta especificação aprovada; branch própria | — |
| 1 | Canal Meta social: credenciais, conexão em Conexões, webhook assinado, DM na Inbox, envio, janela 24 h | conta de teste real: DM entra e sai |
| 2 | Comentários: ingestão, painel Instagram, gatilho + ação (resposta pública + DM), etiqueta e lead | comentar do outro perfil → resposta + DM na Inbox |
| 3 | Fluxos visuais (módulo) com preview | fluxo de 3 passos rodando de ponta a ponta |
| 4 | Live, Story, menções, Facebook (Páginas e Messenger) | um caso real por tipo |
| 5 | Tech Provider: App Review, desautorização e exclusão de dados, política de privacidade, multi-organização | revisão da Meta |

Cada fase sai como PR próprio, com migration (tripla + baseline), prova pela tela, fragmento em `.changes/` e destino declarado.

## Pontos que precisam existir antes do Tech Provider (anotados agora)

- Callback de **desautorização** e de **exclusão de dados** (hoje inexistentes) e página de instruções de exclusão.
- A Política de Privacidade (`/legal/privacy`) não cita Instagram/Meta: precisa de seção sobre dados recebidos da Meta.

## Decisões minhas, para conferir

1. Fluxos como **módulo**, resto como **núcleo** (acima).
2. Provider social Meta **substitui** o `zernio_social` para contas novas; o Zernio não é removido nem desligado (doutrina: não extrair o que já foi distribuído).
3. Credenciais do app Meta na **instalação**; com Tech Provider, a conexão passa a ser por organização.
4. Painel com nome da rede (**Instagram**, **Facebook**) como itens de menu próprios; configuração do app em Conexões.

## O que fica para quem constrói

Nome exato das tabelas e colunas, forma do documento do fluxo, lista final de campos de webhook por fase,
textos de tela, desenho visual do editor.
