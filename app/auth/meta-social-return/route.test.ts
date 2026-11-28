import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Eagle CRM" }) }));

import { GET } from "./route";

const ESTADO = `${"A".repeat(40)}.${"a".repeat(64)}`;

async function ponte(query: string) {
  const r = await GET(new Request(`https://crm.exemplo.com/auth/meta-social-return?${query}`));
  return { status: r.status, html: await r.text() };
}

describe("ponte de volta do login da Meta (rota pública, sem efeito)", () => {
  it("repassa estado e código à tela de Conexões, por um destino nosso", async () => {
    const { status, html } = await ponte(`code=ABCdef123_-.xyz9&state=${ESTADO}`);
    expect(status).toBe(200);
    expect(html).toContain("/app/connections?aba=meta-social");
    expect(html).toContain(`ms_estado=${ESTADO}`);
    expect(html).toContain("ms_code=ABCdef123_-.xyz9");
  });

  it("recusa do usuário na Meta volta com um código de erro conhecido, sem o texto da Meta", async () => {
    const { html } = await ponte(`error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}&state=${ESTADO}`);
    expect(html).toContain("ms_erro=access_denied");
    expect(html).not.toContain("alert(1)");
  });

  it("estado fora do formato: volta para Conexões sem carregar nada da URL", async () => {
    const { html } = await ponte("code=ABCdef123_-.xyz9&state=forjado");
    expect(html).toContain("/app/connections?aba=meta-social");
    expect(html).not.toContain("ms_code");
    expect(html).not.toContain("forjado");
  });

  it("código com caracteres estranhos é descartado (vai parar numa URL nossa)", async () => {
    const { html } = await ponte(`code=${encodeURIComponent('x"><script>')}&state=${ESTADO}`);
    expect(html).not.toContain("ms_code");
    expect(html).not.toContain("<script>x");
  });

  it("não depende de sessão nem grava nada: é só um GET", async () => {
    const { status } = await ponte("");
    expect(status).toBe(200);
  });
});
