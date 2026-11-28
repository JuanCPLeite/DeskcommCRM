/**
 * O segundo modo do canal DIRETO: o LOGIN EMPRESARIAL DO INSTAGRAM (a "API do Instagram com login
 * do Instagram"). Quem conecta autoriza SÓ a conta do Instagram — sem Página do Facebook — e o
 * token (`IGAA…`) fala com `graph.instagram.com`, não com `graph.facebook.com`.
 *
 * Por que existe: no app com login unificado a Meta entrega o webhook de COMENTÁRIO mas não o de
 * DM (medido: a API de conversas enxerga a mensagem e o aviso não vem). Este modo é o que apps
 * mais antigos usam e recebem DM em tempo real.
 *
 * Qual modo vale é decidido pela CONFIGURAÇÃO DO APP da instalação: com ID da configuração do
 * login preenchido é o unificado; vazio, é este. Cada sessão guarda o modo em que foi conectada
 * (`metadata.login_modo`), porque o token de um modo não fala no host do outro.
 *
 * O token vai no cabeçalho `Authorization`. A exceção é imposta pela Meta: a troca por token de
 * longa duração e a renovação recebem o token e a chave na query (servidor a servidor, HTTPS) —
 * por isso estas duas funções NUNCA registram a URL.
 */
import { graphBaseUrl } from "../meta/graph-base";

export type ModoDoLogin = "unificado" | "instagram";

export const HOST_DA_GRAPH_DO_INSTAGRAM = "https://graph.instagram.com";
const VERSAO_DO_INSTAGRAM = "v25.0";
const TIMEOUT_MS = 20_000;

/** Os escopos do login empresarial: perfil, mensagens e comentários. Publicar e insights ficam fora. */
export const ESCOPOS_DO_LOGIN_DO_INSTAGRAM = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

/** A base da Graph para o modo da sessão. Sessão antiga, sem o campo, é a unificada. */
export function baseDaGraph(modo: ModoDoLogin | undefined | null): string {
  return modo === "instagram" ? `${HOST_DA_GRAPH_DO_INSTAGRAM}/${VERSAO_DO_INSTAGRAM}` : graphBaseUrl();
}

export function modoDaSessao(metadata: unknown): ModoDoLogin {
  const m = (metadata as Record<string, unknown> | null | undefined)?.login_modo;
  return m === "instagram" ? "instagram" : "unificado";
}

/** O modo que a configuração do app da instalação pede: sem ID da configuração é o do Instagram. */
export function modoDaConfiguracao(app: { loginConfigId: string | null }): ModoDoLogin {
  return app.loginConfigId ? "unificado" : "instagram";
}

export function urlDeAutorizacaoDoInstagram(input: { appId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    force_reauth: "true",
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: ESCOPOS_DO_LOGIN_DO_INSTAGRAM.join(","),
    state: input.state,
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

async function json<T>(resposta: Response): Promise<T> {
  return (await resposta.json().catch(() => ({}))) as T;
}

interface ErroDaMeta {
  error?: { message?: string };
  error_message?: string;
}

function motivo(corpo: ErroDaMeta, status: number): string {
  return corpo.error?.message ?? corpo.error_message ?? `HTTP ${status}`;
}

/**
 * Troca o código pelo token de LONGA duração (60 dias). Dois passos da Meta: o código vira um
 * token curto (corpo do POST, a chave não toca URL), e o curto vira o longo.
 */
export async function trocarCodigoDoInstagram(input: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; expiraEm: Date | null; userId: string | null }> {
  const curta = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.appId,
      client_secret: input.appSecret,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      // A Meta devolve o código terminado em `#_`: não faz parte dele.
      code: input.code.replace(/#_$/, ""),
    }).toString(),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const c = await json<{ access_token?: string; user_id?: number | string } & ErroDaMeta>(curta);
  if (!curta.ok || !c.access_token) throw new Error(`Troca do código falhou: ${motivo(c, curta.status)}`);

  const q = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: input.appSecret, access_token: c.access_token });
  const longa = await fetch(`${HOST_DA_GRAPH_DO_INSTAGRAM}/access_token?${q.toString()}`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const l = await json<{ access_token?: string; expires_in?: number } & ErroDaMeta>(longa);
  // Sem o token longo a conexão ainda vale pelas ~1 hora do curto, mas vence antes de a pessoa notar:
  // melhor recusar e deixar tentar de novo.
  if (!longa.ok || !l.access_token) throw new Error(`Token de longa duração falhou: ${motivo(l, longa.status)}`);
  return {
    accessToken: l.access_token,
    expiraEm: typeof l.expires_in === "number" ? new Date(Date.now() + l.expires_in * 1000) : null,
    userId: c.user_id !== undefined ? String(c.user_id) : null,
  };
}

/** Renova o token de longa duração (vale mais 60 dias a partir de agora). Devolve `null` se a Meta recusar. */
export async function renovarTokenDoInstagram(token: string): Promise<{ accessToken: string; expiraEm: Date | null } | null> {
  try {
    const q = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
    const resposta = await fetch(`${HOST_DA_GRAPH_DO_INSTAGRAM}/refresh_access_token?${q.toString()}`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = await json<{ access_token?: string; expires_in?: number }>(resposta);
    if (!resposta.ok || !corpo.access_token) return null;
    return {
      accessToken: corpo.access_token,
      expiraEm: typeof corpo.expires_in === "number" ? new Date(Date.now() + corpo.expires_in * 1000) : null,
    };
  } catch {
    return null;
  }
}

export interface PerfilDoInstagram {
  /** O id que o webhook e a API de mensagens usam (`user_id`, não o `id` de escopo do app). */
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

export async function perfilDoInstagram(token: string): Promise<PerfilDoInstagram> {
  const resposta = await fetch(`${baseDaGraph("instagram")}/me?fields=user_id,username,name,profile_picture_url`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const corpo = await json<{ user_id?: string | number; id?: string | number; username?: string; name?: string; profile_picture_url?: string } & ErroDaMeta>(
    resposta,
  );
  const id = corpo.user_id ?? corpo.id;
  if (!resposta.ok || id === undefined) throw new Error(`Leitura do perfil falhou: ${motivo(corpo, resposta.status)}`);
  return { id: String(id), username: corpo.username ?? "", name: corpo.name, profile_picture_url: corpo.profile_picture_url };
}
