/**
 * O login unificado da Meta para o canal DIRETO de Instagram/Facebook.
 *
 * Três peças:
 *  - o ESTADO da ida e volta (organização e pessoa que iniciaram), assinado e com
 *    prazo — a volta da Meta chega por navegação de outro site, então o cookie de
 *    sessão (Strict) não viaja e o estado é a única coisa que liga a volta à ida;
 *  - a URL que leva a pessoa ao diálogo de consentimento;
 *  - a troca do código pelo token, que carrega a chave secreta do app e por isso
 *    sai SEMPRE pelo servidor, no corpo da chamada, nunca numa URL de navegador.
 *
 * O estado reaproveita o formato de `../estado-da-volta.ts` (carga em base64url +
 * HMAC-SHA256), com o campo do "perfil" fixado em `meta_social`: um estado emitido
 * por outro fluxo (o do parceiro) não serve aqui, e o contrário também não.
 */
import { emitirEstadoDaVolta, verificarEstadoDaVolta } from "../estado-da-volta";
import { graphBaseUrl } from "../meta/graph-base";

/** O valor que marca o estado como deste fluxo. */
export const ESTADO_DO_PROVEDOR = "meta_social";

export interface EstadoDaMeta {
  organizationId: string;
  userId: string;
  expiraEmMs: number;
}

export function paraEstadoDaMeta(
  dados: { organizationId: string; userId: string },
  opcoes: { segredo: string; agora: Date },
): string {
  return emitirEstadoDaVolta({ ...dados, profileId: ESTADO_DO_PROVEDOR }, opcoes);
}

/** `null` para tudo o que não for um estado NOSSO deste fluxo, íntegro e no prazo. */
export function verificarEstadoDaMeta(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDaMeta | null {
  const estado = verificarEstadoDaVolta(token, opcoes);
  if (!estado || estado.profileId !== ESTADO_DO_PROVEDOR) return null;
  return { organizationId: estado.organizationId, userId: estado.userId, expiraEmMs: estado.expiraEmMs };
}

/**
 * A URL do diálogo do login unificado. A configuração do login carrega as
 * permissões e o seletor de contas, então não há `scope`. `prompt=login` oferece
 * o login do Instagram e o do Facebook, mesmo a quem já está logado no Facebook.
 */
export function urlDeAutorizacao(input: {
  appId: string;
  loginConfigId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.appId,
    config_id: input.loginConfigId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    prompt: "login",
    state: input.state,
  });
  return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

/** Troca o código pelo token final (usuário de sistema do portfólio). Lança com a mensagem da Meta, sem a chave. */
export async function trocarCodigo(input: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string }> {
  const resposta = await fetch(`${graphBaseUrl()}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.appId,
      client_secret: input.appSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    }).toString(),
    cache: "no-store",
    redirect: "error",
  });
  const corpo = (await resposta.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };
  if (!resposta.ok || !corpo.access_token) {
    throw new Error(`Troca do código falhou: ${corpo.error?.message ?? `HTTP ${resposta.status}`}`);
  }
  return { accessToken: corpo.access_token };
}
