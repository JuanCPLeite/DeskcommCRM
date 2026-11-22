-- manifest: **Tech Provider: o app da Meta da instalação ganha `app_id` e os `config_id` do Embedded Signup, a empresa ganha liberação própria (Embedded Signup, coexistência e teto de números) e a conexão por Embedded Signup ganha onde guardar o que é só do servidor (PIN cifrado, coexistência).** `platform_meta_app` ganha `app_id`, `signup_config_id`, `signup_config_id_coexistencia` e `signup_liberado_por_padrao`; nasce `organization_meta_access` (exceção POR EMPRESA, linha ausente = herda `signup_liberado_por_padrao`) e `channel_session_meta_signup` (1:1 com `channel_sessions`, só service_role). Aditiva e idempotente; nenhuma coluna de `channel_sessions` muda, então o gatilho da 9093/9104/9328 não é tocado.
--
-- 9452 — a segunda porta do número oficial (#4074) precisa de estado próprio.
--
-- ═══ Por quê ═══
--
-- A 9328 deu à conexão oficial uma procedência (`embedded_signup` | `token_manual`)
-- mas deixou de fora o que o Embedded Signup precisa para existir: o `app_id` do app
-- da instalação e o `config_id` da configuração de Login do Facebook for Business
-- (um para número novo, outro para coexistência com o app WhatsApp Business).
-- Sem isso o botão da Meta não abre. Os três são IDENTIFICADORES PÚBLICOS — o
-- `app_id` e o `config_id` vão ao navegador por desenho, a Meta os exige no
-- `FB.init`/`FB.login` — e por isso são colunas em claro, ao contrário do App Secret.
--
-- ═══ Por que a liberação é POR EMPRESA e não pelo módulo opcional (9416) ═══
--
-- `organization_modules` tem a instalação como TETO: instalação desligada vence a
-- linha `ligado` da empresa. Quem revende precisa do contrário — Embedded Signup
-- DESLIGADO para a maioria e LIGADO para o cliente que contratou. Aqui a empresa é
-- a exceção em qualquer direção, e a ausência de linha herda
-- `platform_meta_app.signup_liberado_por_padrao` (nasce `false`: uma instalação
-- que acabou de preencher o app não abre a conexão de terceiros a todo cliente
-- sem ninguém decidir).
--
-- `max_numeros` é o teto de números oficiais da empresa e VALE EM CIMA do limite do
-- plano (`trg_trava_canais_do_plano`): o menor dos dois manda. Nulo = só o plano.
--
-- ═══ Por que `channel_session_meta_signup` é tabela, e não coluna ═══
--
-- `channel_sessions` tem GRANT ALL para `authenticated` e um gatilho que lista as
-- colunas que o cliente NÃO pode escrever. Cada coluna nova ali exige substituir a
-- função inteira (foi o que a 9328 fez). O PIN de verificação em duas etapas do
-- número e a marca de coexistência são segredo/estado do servidor — nasceriam
-- desprotegidos se esquecidos no gatilho. Tabela própria, com RLS ligada, ZERO
-- policies e grants revogados, é inalcançável pela API por construção (mesma
-- doutrina de `platform_meta_app`, 0257).

alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists signup_config_id text,
  add column if not exists signup_config_id_coexistencia text,
  add column if not exists signup_liberado_por_padrao boolean not null default false;

comment on column public.platform_meta_app.app_id is
  'ID do app da Meta desta instalação (Tech Provider). Público por desenho: o navegador o recebe para abrir o Embedded Signup. Não é segredo.';
comment on column public.platform_meta_app.signup_config_id is
  'config_id da configuração de Login do Facebook for Business para conectar um NÚMERO NOVO pelo Embedded Signup. Público por desenho.';
comment on column public.platform_meta_app.signup_config_id_coexistencia is
  'config_id da configuração para conectar um número que JÁ está no app WhatsApp Business (coexistência). Público por desenho. Nulo = usa o signup_config_id (na versão 5 do Embedded Signup a coexistência já vem ligada na mesma configuração).';
comment on column public.platform_meta_app.signup_liberado_por_padrao is
  'Empresa SEM linha em organization_meta_access herda este valor. false = o Embedded Signup só abre para quem foi liberado explicitamente.';

create table if not exists public.organization_meta_access (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Três estados: true libera, false bloqueia, nulo herda a instalação.
  embedded_signup boolean,
  coexistencia boolean,
  -- Teto de números oficiais desta empresa. Nulo = vale só o limite do plano.
  max_numeros integer,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint organization_meta_access_max_numeros_valido
    check (max_numeros is null or max_numeros >= 0)
);

comment on table public.organization_meta_access is
  'Liberação do canal oficial POR EMPRESA (Tech Provider): Embedded Signup, coexistência e teto de números. Exceção da empresa; linha ausente ou campo nulo herda platform_meta_app.signup_liberado_por_padrao. Server-side only: RLS ligada sem policies, grants revogados de anon/authenticated.';
comment on column public.organization_meta_access.max_numeros is
  'Teto de números oficiais da empresa; o menor entre este e o limite do plano manda. Nulo = só o plano.';

alter table public.organization_meta_access enable row level security;

revoke all on public.organization_meta_access from anon, authenticated;
grant select, insert, update, delete on public.organization_meta_access to service_role;

drop trigger if exists trg_organization_meta_access_updated_at on public.organization_meta_access;
create trigger trg_organization_meta_access_updated_at
  before update on public.organization_meta_access
  for each row execute function public.fn_set_updated_at();

create table if not exists public.channel_session_meta_signup (
  channel_session_id uuid primary key references public.channel_sessions(id) on delete cascade,
  -- Denormalizado de `channel_sessions` de propósito: todo acesso do servidor
  -- filtra por organização (doutrina de multi-tenancy), e o filtro direto evita
  -- depender de um join para não vazar entre tenants.
  organization_id uuid not null references public.organizations(id) on delete cascade,
  coexistencia boolean not null default false,
  -- PIN de 2 etapas do número (6 dígitos), cifrado por `fn_encrypt_oauth`.
  -- Nulo em coexistência (o número já está registrado no app, não se registra).
  pin_encrypted text,
  -- A Meta dá 24 h para pedir a sincronização de contatos/histórico de um número
  -- em coexistência; estes dois carimbos dizem se o pedido foi feito.
  contatos_pedidos_em timestamptz,
  historico_pedido_em timestamptz,
  sincronizacao_erro text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists channel_session_meta_signup_org_idx
  on public.channel_session_meta_signup (organization_id);

comment on table public.channel_session_meta_signup is
  'Estado SÓ DO SERVIDOR de uma conexão oficial nascida do Embedded Signup: marca de coexistência, PIN cifrado e carimbos da sincronização de histórico. 1:1 com channel_sessions. RLS ligada sem policies; grants revogados de anon/authenticated.';
comment on column public.channel_session_meta_signup.pin_encrypted is
  'PIN de verificação em duas etapas, cifrado por fn_encrypt_oauth. Nunca em claro; nunca devolvido a nenhuma tela.';

alter table public.channel_session_meta_signup enable row level security;

revoke all on public.channel_session_meta_signup from anon, authenticated;
grant select, insert, update, delete on public.channel_session_meta_signup to service_role;

drop trigger if exists trg_channel_session_meta_signup_updated_at on public.channel_session_meta_signup;
create trigger trg_channel_session_meta_signup_updated_at
  before update on public.channel_session_meta_signup
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
