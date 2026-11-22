/**
 * O que a janela do Embedded Signup devolve ao NAVEGADOR — e como lê-lo sem confiar.
 *
 * A janela avisa a página por `window.postMessage`, e esse canal é aberto: qualquer
 * página dentro do navegador pode postar uma mensagem com a mesma forma. Por isso
 * dois cuidados vivem aqui, puros e testáveis:
 *
 *  1. a ORIGEM é conferida (`origemEhDaMeta`) antes de se olhar o conteúdo;
 *  2. o conteúdo é lido como `unknown` e só o que é do formato esperado vira dado —
 *     o resto é descartado, nunca repassado ao servidor.
 *
 * ⚠️ Nada que sai daqui é CONFIANÇA. O `waba_id` e o `phone_number_id` do evento
 * são INFORMAÇÃO DO NAVEGADOR; o servidor só os usa depois de provar, com o token
 * trocado do `code`, que o número realmente pertence àquela conta
 * (`validateMetaCredentials` com `wabaId`). Este arquivo não decide nada sobre
 * permissão.
 *
 * Arquivo sem import de servidor: é usado pelo componente de cliente.
 */

export type EventoDoSignup =
  | {
      tipo: "concluido";
      /** `FINISH` = número novo; `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` = coexistência. */
      evento: "FINISH" | "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
      wabaId: string | null;
      phoneNumberId: string | null;
    }
  | { tipo: "cancelado"; etapa: string | null }
  | { tipo: "erro"; mensagem: string | null; codigo: string | null };

/** Os ids da Meta são numéricos, e uma lista fechada de caracteres evita lixo no corpo. */
const FORMATO_DE_ID = /^[0-9]{5,30}$/;

function idOuNulo(valor: unknown): string | null {
  return typeof valor === "string" && FORMATO_DE_ID.test(valor) ? valor : null;
}

function textoCurto(valor: unknown): string | null {
  return typeof valor === "string" ? valor.slice(0, 200) : null;
}

/**
 * A mensagem veio da Meta? A documentação confere `origin.endsWith("facebook.com")`.
 *
 * Mais estrito: o host tem de ser `facebook.com` ou subdomínio dele, com HTTPS. Um
 * `endsWith` puro aceitaria `evilfacebook.com`.
 */
export function origemEhDaMeta(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    return u.hostname === "facebook.com" || u.hostname.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

/** Lê o `event.data` (string JSON ou objeto). `null` = não é do Embedded Signup. */
export function lerEventoDoSignup(dados: unknown): EventoDoSignup | null {
  let bruto: unknown = dados;
  if (typeof dados === "string") {
    try {
      bruto = JSON.parse(dados);
    } catch {
      return null;
    }
  }
  if (!bruto || typeof bruto !== "object") return null;
  const msg = bruto as { type?: unknown; event?: unknown; data?: unknown };
  if (msg.type !== "WA_EMBEDDED_SIGNUP") return null;
  const data = (msg.data && typeof msg.data === "object" ? msg.data : {}) as Record<string, unknown>;

  if (msg.event === "FINISH" || msg.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    return {
      tipo: "concluido",
      evento: msg.event,
      wabaId: idOuNulo(data.waba_id),
      // Em coexistência a documentação mostra o evento só com o `waba_id`: ausência
      // aqui é ESPERADA, e o servidor descobre o número pela WABA.
      phoneNumberId: idOuNulo(data.phone_number_id),
    };
  }
  if (msg.event === "CANCEL") {
    return { tipo: "cancelado", etapa: textoCurto(data.current_step) };
  }
  if (msg.event === "ERROR") {
    return { tipo: "erro", mensagem: textoCurto(data.error_message), codigo: textoCurto(data.error_code) };
  }
  return null;
}
