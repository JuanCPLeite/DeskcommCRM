/**
 * O lado do SERVIDOR do Embedded Signup (#4074): o que se faz com o `code` que a
 * janela da Meta devolve ao navegador.
 *
 * Mora aqui, e não na rota, pelo mesmo motivo de `validate-credentials.ts` e
 * `webhook-override.ts`: a catraca (`scripts/lint-channels.ts`) proíbe chamada à
 * Graph API fora de `lib/channels/`, e a rota não deve saber com quem fala.
 *
 * ─── O contrato com a Meta, e o que NÃO foi provado ─────────────────────────
 *
 * Os passos abaixo seguem a documentação oficial lida em 2026-11-21 (Embedded
 * Signup, onboarding de Tech Provider e coexistência). O que depende de um app
 * REAL da Meta — token que de fato é devolvido, validade dele, o `phone_number_id`
 * que a coexistência não traz no evento — não pode ser provado sem um app Tech
 * Provider, e por isso cada função devolve o MOTIVO da Meta em vez de assumir
 * sucesso. A prova ponta a ponta é a conexão de um número de teste.
 *
 * ─── Nada aqui loga token, segredo ou o `code` ──────────────────────────────
 *
 * O `code` é uma credencial de uso único (vale 5 minutos) e o App Secret viaja na
 * troca. Os motivos de erro devolvidos vêm da resposta da Meta, nunca da URL.
 */
import { randomInt } from "node:crypto";

import { graphBaseUrl } from "./graph-base";

export type ModoDoSignup = "numero_novo" | "coexistencia";

export const MODOS_DO_SIGNUP: readonly ModoDoSignup[] = ["numero_novo", "coexistencia"];

/**
 * A versão do Embedded Signup que o navegador pede em `extras.version`. A Meta
 * serve como v4 qualquer pedido sem versão ou com versão inválida, e a v5 é a atual
 * (lançada em 20/10/2026) — com a coexistência LIGADA por padrão.
 */
export const VERSAO_DO_SIGNUP = "v5";

/** O nome da funcionalidade de coexistência nos `features` da v5. */
const FEATURE_DA_COEXISTENCIA = "whatsapp_business_app_onboarding";

/**
 * O `extras` do `FB.login`, para cada modo.
 *
 * Puro de propósito: é o ponto onde o produto e a Meta mais se desencontram (a v5
 * ligou a coexistência por padrão, a v4 exigia pedi-la), e o que vai ao navegador
 * precisa ser conferível por teste — a janela da Meta aceita lixo calada.
 *
 * - `numero_novo` na v5: desliga a coexistência, senão a janela oferece ao cliente
 *   um caminho que esta empresa pode não ter sido liberada para usar.
 * - `coexistencia` na v5: o padrão da versão já é ligado.
 */
export function extrasDoSignup(modo: ModoDoSignup): Record<string, unknown> {
  if (modo === "coexistencia") {
    return { setup: {}, version: VERSAO_DO_SIGNUP };
  }
  return {
    setup: {},
    version: VERSAO_DO_SIGNUP,
    features: [{ name: FEATURE_DA_COEXISTENCIA, enabled: false }],
  };
}

interface RespostaDaGraph {
  ok: boolean;
  status: number;
  body: unknown;
}

/** O detalhe útil da Meta, sem jamais repetir o que o operador enviou. */
function motivoDoErro(res: RespostaDaGraph): string {
  const b = res.body as { error?: { message?: string; error_data?: { details?: string } } } | null;
  return (
    b?.error?.error_data?.details ??
    b?.error?.message ??
    (res.status === 0 ? "rede indisponível" : `http_${res.status}`)
  );
}

async function chamarAGraph(
  url: string,
  init: { method: "GET" | "POST"; token?: string; corpo?: unknown },
): Promise<RespostaDaGraph> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.corpo !== undefined ? { body: JSON.stringify(init.corpo) } : {}),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    // Rede caída não é credencial ruim: o motivo diz isso, para o operador não
    // refazer o cadastro inteiro por um erro que não é dele.
    return {
      ok: false,
      status: 0,
      body: { error: { message: `rede indisponível: ${err instanceof Error ? err.message : "erro"}` } },
    };
  }
}

export type TrocaDoCodigo = { ok: true; accessToken: string } | { ok: false; motivo: string };

/**
 * Troca o `code` do navegador pelo token do cliente (o "business token").
 *
 * O `code` vale 5 minutos e é de uso único. `redirect_uri` NÃO é enviado: a
 * documentação não o inclui na troca do Embedded Signup.
 */
export async function trocarCodigoPorToken(input: {
  appId: string;
  appSecret: string;
  code: string;
}): Promise<TrocaDoCodigo> {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  });
  const res = await chamarAGraph(`${graphBaseUrl()}/oauth/access_token?${params.toString()}`, {
    method: "GET",
  });
  const token = (res.body as { access_token?: unknown } | null)?.access_token;
  if (!res.ok || typeof token !== "string" || token.length < 20) {
    return { ok: false, motivo: motivoDoErro(res) };
  }
  return { ok: true, accessToken: token };
}

export interface NumeroDaWaba {
  readonly id: string;
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
}

export type DescobertaDeNumeros =
  | { ok: true; numeros: readonly NumeroDaWaba[] }
  | { ok: false; motivo: string };

/**
 * Os números da WABA — para quando o evento da janela não traz o `phone_number_id`
 * (é o caso documentado da coexistência, que só devolve o `waba_id`).
 */
export async function descobrirNumerosDaWaba(input: {
  wabaId: string;
  token: string;
}): Promise<DescobertaDeNumeros> {
  const res = await chamarAGraph(
    `${graphBaseUrl()}/${input.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
    { method: "GET", token: input.token },
  );
  if (!res.ok) return { ok: false, motivo: motivoDoErro(res) };
  const lista = (res.body as { data?: unknown } | null)?.data;
  if (!Array.isArray(lista)) return { ok: false, motivo: "resposta_sem_lista_de_numeros" };
  const numeros: NumeroDaWaba[] = [];
  for (const item of lista) {
    const n = item as { id?: unknown; display_phone_number?: unknown; verified_name?: unknown };
    if (typeof n.id !== "string" || n.id === "") continue;
    numeros.push({
      id: n.id,
      displayPhoneNumber: typeof n.display_phone_number === "string" ? n.display_phone_number : null,
      verifiedName: typeof n.verified_name === "string" ? n.verified_name : null,
    });
  }
  return { ok: true, numeros };
}

/** PIN de 6 dígitos da verificação em duas etapas (CSPRNG, nunca `Math.random`). */
export function gerarPinDoNumero(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type DesfechoSimples = { ok: true } | { ok: false; motivo: string };

/**
 * Registra o número na Cloud API. SÓ para número novo: na coexistência o número já
 * está registrado no app WhatsApp Business e esta chamada não deve ser feita.
 */
export async function registrarNumeroNaCloudApi(input: {
  phoneNumberId: string;
  token: string;
  pin: string;
}): Promise<DesfechoSimples> {
  const res = await chamarAGraph(`${graphBaseUrl()}/${input.phoneNumberId}/register`, {
    method: "POST",
    token: input.token,
    corpo: { messaging_product: "whatsapp", pin: input.pin },
  });
  return res.ok ? { ok: true } : { ok: false, motivo: motivoDoErro(res) };
}

export interface SincronizacaoDaCoexistencia {
  readonly contatos: DesfechoSimples;
  readonly historico: DesfechoSimples;
}

/**
 * Pede à Meta a sincronização de contatos e de histórico de um número em
 * coexistência.
 *
 * A Meta dá 24 HORAS depois do cadastro; passado o prazo o cliente precisa refazer
 * o fluxo. Cada pedido só pode ser feito UMA vez por número, então a rota chama
 * isto uma única vez, logo após conectar, e grava o desfecho.
 */
export async function sincronizarCoexistencia(input: {
  phoneNumberId: string;
  token: string;
}): Promise<SincronizacaoDaCoexistencia> {
  const pedir = async (syncType: "smb_app_state_sync" | "history"): Promise<DesfechoSimples> => {
    const res = await chamarAGraph(`${graphBaseUrl()}/${input.phoneNumberId}/smb_app_data`, {
      method: "POST",
      token: input.token,
      corpo: { messaging_product: "whatsapp", sync_type: syncType },
    });
    return res.ok ? { ok: true } : { ok: false, motivo: motivoDoErro(res) };
  };
  // Contatos primeiro, depois histórico — a ordem da documentação.
  const contatos = await pedir("smb_app_state_sync");
  const historico = await pedir("history");
  return { contatos, historico };
}
