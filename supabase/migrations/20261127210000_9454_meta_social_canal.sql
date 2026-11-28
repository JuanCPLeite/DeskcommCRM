-- manifest: Canal direto com a Meta (Instagram/Facebook pelo app Meta da instalação): provider `meta_social`, a conta Meta como endereço do canal (única entre organizações), o token cifrado da sessão e as credenciais do app numa tabela exclusiva do servidor.
--
-- ─── Por quê ───────────────────────────────────────────────────────────────
-- Instagram/Facebook entravam só pelo provedor intermediário (`zernio_social`). A
-- conexão DIRETA pelo app Meta da instalação (login unificado, futuro Tech
-- Provider) precisa de um valor de provider próprio e de um endereço próprio:
-- o id da conta que a Graph API endereça. O intermediário continua existindo.
--
-- ─── O que muda ────────────────────────────────────────────────────────────
-- 1. `channel_sessions`: `social_account_id`, `meta_social_token_encrypted` e
--    `meta_social_token_expires_at`; índice ÚNICO da conta ativa (a mesma conta
--    Instagram não pode estar em duas organizações — o webhook da Meta resolve a
--    organização por ela, então a dupla seria vazamento entre tenants).
-- 2. `channel_sessions_provider_check` e `channel_sessions_provider_ref_check`
--    aceitam `meta_social` (ref: `social_account_id` obrigatório).
-- 3. `webhook_events_log_provider_check` aceita `meta_social`: o corpo cru do
--    webhook é arquivado como o dos outros canais.
-- 4. `platform_meta_social_app`: credenciais do app Meta SOCIAL da instalação
--    (singleton, só servidor), no desenho de `platform_meta_app`.
--
-- Alargamento puro nos CHECKs: nenhuma linha que passava pela lista antiga falha
-- nesta, então não há backfill.

alter table public.channel_sessions
  add column if not exists social_account_id text,
  add column if not exists meta_social_token_encrypted bytea,
  add column if not exists meta_social_token_expires_at timestamptz;

do $$
begin
  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_check
    check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text,
                                 'wacalls'::text, 'zernio_social'::text, 'datafy'::text,
                                 'telegram'::text, 'meta_social'::text]));

  alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
  alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'telegram'   and telegram_bot_id      is not null) or
    (provider = 'meta_social' and social_account_id    is not null)
  );
end
$$;

do $$
begin
  alter table public.webhook_events_log drop constraint if exists webhook_events_log_provider_check;
  alter table public.webhook_events_log add constraint webhook_events_log_provider_check
    check (provider in (
      'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy',
      'stripe', 'asaas', 'efi', 'telegram', 'meta_social'
    ));
end
$$;

create unique index if not exists channel_sessions_social_account_id_ativo_unique
  on public.channel_sessions (social_account_id)
  where archived_at is null and social_account_id is not null;

do $canal_meta_social$
begin
  if to_regclass('public.channel_sessions') is not null then
    comment on column public.channel_sessions.social_account_id is
      'Id da conta Instagram/Facebook que a Graph API endereça (IG user id). É o sessionRef do canal meta_social e a chave que o webhook da Meta usa para achar a organização.';
    comment on column public.channel_sessions.meta_social_token_encrypted is
      'Token do login unificado cifrado por fn_encrypt_oauth. Nunca volta para a tela nem para o log.';
    comment on index public.channel_sessions_social_account_id_ativo_unique is
      'Uma conta Meta é UMA conexão ativa: o webhook resolve a organização por ela, e duas organizações com a mesma conta misturariam as caixas de entrada.';
  end if;
end
$canal_meta_social$;

-- ─── Credenciais do app Meta social (instalação) ───────────────────────────
-- Mesmo desenho de `platform_meta_app`: uma linha só, RLS ligada SEM policies,
-- `anon`/`authenticated` revogados e acesso pelo `service_role` atrás do gate
-- administrativo. Os dois segredos nunca voltam ao navegador.
create table if not exists public.platform_meta_social_app (
  id smallint primary key default 1,
  app_id text,
  login_config_id text,
  app_secret_encrypted bytea,
  verify_token_encrypted bytea,
  verify_token_created_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint platform_meta_social_app_singleton check (id = 1)
);

comment on table public.platform_meta_social_app is
  'O app Meta DESTA INSTALAÇÃO para Instagram/Facebook (singleton): ID do app e da configuração do login (públicos), chave secreta que assina o webhook e token de verificação do handshake (cifrados). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated.';

alter table public.platform_meta_social_app enable row level security;

revoke all on public.platform_meta_social_app from anon, authenticated;
grant select, insert, update on public.platform_meta_social_app to service_role;

drop trigger if exists trg_platform_meta_social_app_updated_at on public.platform_meta_social_app;
create trigger trg_platform_meta_social_app_updated_at
  before update on public.platform_meta_social_app
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
