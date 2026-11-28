import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";
import { FORMATO_DO_ESTADO } from "@/lib/channels/estado-da-volta";

/**
 * A VOLTA do login unificado da Meta (conexão direta de Instagram/Facebook).
 *
 * Chega por navegação de outro site, então o cookie de sessão (Strict) não vem:
 * esta rota é pública e NÃO grava nem troca nada. Ela só repassa à tela de
 * Conexões, por uma ponte same-origin (`respostaDePonte`), o que a Meta trouxe —
 * e cada valor passa por um formato fixo antes, porque vai parar numa URL nossa.
 * Quem conclui é a tela, autenticada, chamando `POST /api/v1/channels/meta-social`,
 * e lá o servidor confere a assinatura do estado e a sessão que o iniciou.
 *
 * Irmã de `app/auth/partner-return/[estado]/route.ts`. Aqui o estado vem na QUERY
 * (a Meta o devolve como `state=`), não no caminho.
 */
const BASE = "/app/connections?aba=meta-social";
/** O código de autorização da Meta: alfanumérico, `_`, `-`, `.` e `~`. */
const CODIGO = /^[A-Za-z0-9_\-.~]{10,2048}$/;
const CODIGO_DE_ERRO = /^[a-z_]{1,60}$/;

function destino(params: URLSearchParams): string {
  const estado = params.get("state");
  if (!estado || !FORMATO_DO_ESTADO.test(estado)) return BASE;

  const q = new URLSearchParams({ ms_estado: estado });
  const erro = params.get("error");
  const code = params.get("code");
  if (erro !== null) {
    // Só o CÓDIGO do erro: o texto livre da Meta nunca entra numa URL nossa.
    q.set("ms_erro", erro && CODIGO_DE_ERRO.test(erro) ? erro : "meta_erro");
  } else if (code && CODIGO.test(code)) {
    q.set("ms_code", code);
  } else {
    return BASE;
  }
  return `${BASE}&${q.toString()}`;
}

export async function GET(request: Request) {
  const alvo = destino(new URL(request.url).searchParams);
  const marca = await marcaDaSaida(null);
  return respostaDePonte(alvo, marca.nome, "Voltando para suas conexões…");
}
