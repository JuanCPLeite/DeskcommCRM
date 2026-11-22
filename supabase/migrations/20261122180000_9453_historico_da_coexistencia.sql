-- manifest: **Coexistência: o histórico de conversas que a Meta entrega depois da conexão passa a ser importado, e a conexão ganha onde mostrar o andamento.** `channel_session_meta_signup` (a tabela só do servidor da 9452) ganha `historico_progresso`, `historico_mensagens`, `historico_concluido_em`, `historico_erro` e `historico_atualizado_em`: o que a Meta informou, quantas mensagens já entraram e por que parou. Aditiva e idempotente; nenhuma coluna de `channel_sessions` muda, então o gatilho da 9093/9104/9328 não é tocado, e nenhuma função, gatilho ou policy é criada — a importação reaproveita `fn_upsert_wa_conversation_importada` e o corte `metadata.historico_importado` da 0760.
--
-- ═══ Por que as colunas moram aqui, e não em `importacoes_de_historico` ═══
--
-- `importacoes_de_historico` (0761) é o estado do importador do canal por QR: um
-- cursor que RETOMA, e uma rodada que o worker dispara contra o WAHA. O histórico
-- da Meta é o oposto — ele CHEGA por webhook, em pedaços que a Meta escolhe, uma
-- vez só. Uma linha ali seria apanhada por quem procura importação a rodar, e a
-- rodada tentaria ler um acervo no WAHA que este número não tem.
--
-- ═══ O que cada coluna é ═══
--
--   historico_progresso      último percentual que a Meta informou (0–100); só sobe.
--   historico_mensagens      quantas mensagens do histórico JÁ ESTÃO no CRM para este
--                            número — contadas na tabela `messages`, não somadas, para
--                            dois pedaços simultâneos não perderem contagem.
--   historico_concluido_em   a Meta informou 100%.
--   historico_erro           por que parou (o dono não aceitou compartilhar no celular,
--                            a janela de 24 h passou…). Texto curto, sem conteúdo de
--                            conversa e sem telefone.
--   historico_atualizado_em  o último pedaço que chegou.
--
-- Sem string de usuário, sem policy nova: a tabela já tem RLS ligada, zero policies e
-- grants só para service_role (9452).

alter table public.channel_session_meta_signup
  add column if not exists historico_progresso smallint
    check (historico_progresso is null or historico_progresso between 0 and 100),
  add column if not exists historico_mensagens integer not null default 0
    check (historico_mensagens >= 0),
  add column if not exists historico_concluido_em timestamptz,
  add column if not exists historico_erro text,
  add column if not exists historico_atualizado_em timestamptz;

comment on column public.channel_session_meta_signup.historico_progresso is
  'Último percentual (0-100) que a Meta informou para o histórico da coexistência. Só sobe.';
comment on column public.channel_session_meta_signup.historico_mensagens is
  'Mensagens do histórico da coexistência que já estão no CRM para este número (contadas em messages).';
comment on column public.channel_session_meta_signup.historico_erro is
  'Por que o histórico parou (recusa do dono do número, janela de 24 h vencida…). Sem conteúdo de conversa.';

notify pgrst, 'reload schema';
