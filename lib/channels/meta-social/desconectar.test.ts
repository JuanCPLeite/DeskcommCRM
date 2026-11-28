import { beforeEach, describe, expect, it, vi } from "vitest";

const desassinar = vi.fn(async (..._a: unknown[]) => true);
let linha: { social_account_id: string; social_token_encrypted: string | null } | null = {
  social_account_id: "1784",
  social_token_encrypted: "\\xTOKEN",
};
let erroDeLeitura: { code: string } | null = null;
let tokenClaro: string | null = "TOKEN-DO-LOGIN";

vi.mock("@/lib/channels/meta-social/graph", () => ({ desassinarWebhooks: (...a: unknown[]) => desassinar(...a) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => tokenClaro }));

import { desligarContaNaMeta } from "@/lib/channels/meta-social/desconectar";

function dbFalso() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: linha, error: erroDeLeitura }),
  };
  return { from: () => q } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  linha = { social_account_id: "1784", social_token_encrypted: "\\xTOKEN" };
  erroDeLeitura = null;
  tokenClaro = "TOKEN-DO-LOGIN";
  desassinar.mockResolvedValue(true);
});

describe("desligarContaNaMeta (best-effort: nunca lança, nunca impede a desconexão)", () => {
  it("desfaz a assinatura do webhook da conta com o token da sessão", async () => {
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("desfeito");
    expect(desassinar).toHaveBeenCalledWith("TOKEN-DO-LOGIN", "1784");
  });

  it("sem token gravado ou que não decifra: 'sem_credencial', sem chamar a Meta", async () => {
    linha = { social_account_id: "1784", social_token_encrypted: null };
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("sem_credencial");
    linha = { social_account_id: "1784", social_token_encrypted: "\\xTOKEN" };
    tokenClaro = null;
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("sem_credencial");
    expect(desassinar).not.toHaveBeenCalled();
  });

  it("a Meta recusa, o banco falha ou a chamada estoura: 'falhou', sem lançar", async () => {
    desassinar.mockResolvedValueOnce(false);
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("falhou");
    erroDeLeitura = { code: "XX000" };
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("falhou");
    erroDeLeitura = null;
    desassinar.mockRejectedValueOnce(new Error("rede"));
    expect(await desligarContaNaMeta(dbFalso(), "org-A", "sessao-1")).toBe("falhou");
  });
});
