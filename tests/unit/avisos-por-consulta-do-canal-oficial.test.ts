import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  abrirAvisosDasMudancasDosModelos,
  verificarQualidadeDoNumero,
} from "@/lib/channels/meta/avisos-por-consulta";
import { avisoDeQualidadeDoNumeroConsultada } from "@/lib/channels/meta/avisos-de-qualidade";
import {
  mudancasDosModelos,
  type MetaTemplateRow,
  type LocalTemplate,
} from "@/lib/channels/meta/template-sync";

function remoto(over: Partial<MetaTemplateRow> = {}): MetaTemplateRow {
  return {
    organization_id: "org",
    waba_id: "waba",
    name: "boas_vindas",
    language: "pt_BR",
    status: "APPROVED",
    category: "UTILITY",
    rejected_reason: null,
    quality_score: "GREEN",
    components: [],
    contract_hash: "h",
    parameter_format: "POSITIONAL",
    ...over,
  };
}
function local(over: Partial<LocalTemplate> = {}): LocalTemplate {
  return {
    name: "boas_vindas",
    language: "pt_BR",
    status: "APPROVED",
    contract_hash: "h",
    category: "UTILITY",
    quality_score: "GREEN",
    ...over,
  };
}

describe("mudanças dos modelos entre a Meta e o espelho", () => {
  it("nada mudou ⇒ nenhuma mudança", () => {
    expect(mudancasDosModelos([remoto()], [local()])).toEqual([]);
  });

  it("modelo NOVO não é mudança (não existe um 'antes')", () => {
    expect(mudancasDosModelos([remoto({ name: "novo" })], [local()])).toEqual([]);
  });

  it("categoria, qualidade e status que mudam saem juntos, com o de→para", () => {
    const m = mudancasDosModelos(
      [
        remoto({
          category: "MARKETING",
          quality_score: "RED",
          status: "PAUSED",
          rejected_reason: "NONE",
        }),
      ],
      [local()],
    );
    expect(m).toEqual([
      {
        name: "boas_vindas",
        language: "pt_BR",
        status: { de: "APPROVED", para: "PAUSED", motivo: "NONE" },
        categoria: { de: "UTILITY", para: "MARKETING" },
        qualidade: { de: "GREEN", para: "RED" },
      },
    ]);
  });
});

describe("aviso do número por consulta", () => {
  const base = {
    telefone: "+55 11 93623-3390",
    qualidadeAntes: "GREEN",
    qualidadeAgora: "GREEN",
    limiteAntes: "TIER_1K",
    limiteAgora: "TIER_1K",
  };

  it("nada mudou ⇒ sem aviso", () => {
    expect(avisoDeQualidadeDoNumeroConsultada(base)).toBeNull();
  });

  it("qualidade caiu ⇒ atenção, com o de→para no título", () => {
    const a = avisoDeQualidadeDoNumeroConsultada({ ...base, qualidadeAgora: "YELLOW" });
    expect(a).toMatchObject({ kind: "channel_number_alert", severity: "warn" });
    expect(a?.title).toBe("Número +55 11 93623-3390: qualidade alta → média");
  });

  it("qualidade baixa é crítica; subir é boa notícia", () => {
    expect(avisoDeQualidadeDoNumeroConsultada({ ...base, qualidadeAgora: "RED" })?.severity).toBe(
      "critical",
    );
    expect(
      avisoDeQualidadeDoNumeroConsultada({ ...base, qualidadeAntes: "YELLOW" })?.severity,
    ).toBe("info");
  });

  it("o limite que cai avisa; o que sobe é informativo", () => {
    expect(avisoDeQualidadeDoNumeroConsultada({ ...base, limiteAgora: "TIER_250" })?.severity).toBe(
      "warn",
    );
    const sobe = avisoDeQualidadeDoNumeroConsultada({ ...base, limiteAgora: "TIER_10K" });
    expect(sobe?.severity).toBe("info");
    expect(sobe?.title).toContain("1.000 clientes por dia → 10.000 clientes por dia");
  });

  it("valor desconhecido (campo ausente) não inventa mudança", () => {
    expect(
      avisoDeQualidadeDoNumeroConsultada({ ...base, qualidadeAgora: null, limiteAgora: null }),
    ).toBeNull();
  });
});

/** Banco falso: o dedup nunca acha aviso aberto; guarda o que foi inserido e o que foi atualizado. */
function bancoFalso(jaAbertos: string[] = []) {
  const inseridos: Array<Record<string, unknown>> = [];
  const atualizados: Array<Record<string, unknown>> = [];
  let tituloConsultado = "";
  const admin = {
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit", "is"]) c[m] = () => c;
      c.eq = (col: string, v: string) => {
        if (col === "title") tituloConsultado = v;
        return c;
      };
      c.maybeSingle = async () => ({
        data: jaAbertos.includes(tituloConsultado) ? { id: "x" } : null,
        error: null,
      });
      c.insert = async (linha: Record<string, unknown>) => {
        inseridos.push(linha);
        return { error: null };
      };
      c.update = (linha: Record<string, unknown>) => {
        if (tabela === "channel_sessions") atualizados.push(linha);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      };
      return c;
    },
  };
  return { admin: admin as never, inseridos, atualizados };
}

describe("a consulta abre os avisos que o webhook abriria", () => {
  it("categoria virou marketing ⇒ UM aviso de atenção na Central, escopado à conexão", async () => {
    const { admin, inseridos } = bancoFalso();
    const aoMudar = abrirAvisosDasMudancasDosModelos(
      admin,
      { organizationId: "org", channelSessionId: "sess" },
      "waba",
    );
    await aoMudar([
      {
        name: "boas_vindas",
        language: "pt_BR",
        status: null,
        categoria: { de: "UTILITY", para: "MARKETING" },
        qualidade: null,
      },
    ]);
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({
      organization_id: "org",
      ref_kind: "channel_session",
      ref_id: "sess",
      severity: "warn",
    });
    expect(String(inseridos[0]!.title)).toContain("utilidade → marketing");
  });

  it("o mesmo estado já avisado pelo webhook não duplica", async () => {
    const titulo = 'Modelo "boas_vindas" (pt_BR): categoria utilidade → marketing';
    const { admin, inseridos } = bancoFalso([titulo]);
    const aoMudar = abrirAvisosDasMudancasDosModelos(
      admin,
      { organizationId: "org", channelSessionId: "sess" },
      "waba",
    );
    await aoMudar([
      {
        name: "boas_vindas",
        language: "pt_BR",
        status: null,
        categoria: { de: "UTILITY", para: "MARKETING" },
        qualidade: null,
      },
    ]);
    expect(inseridos).toHaveLength(0);
  });

  it("qualidade que sai de 'em avaliação' não é queda: sem aviso", async () => {
    const { admin, inseridos } = bancoFalso();
    const aoMudar = abrirAvisosDasMudancasDosModelos(
      admin,
      { organizationId: "org", channelSessionId: "sess" },
      "waba",
    );
    await aoMudar([
      {
        name: "m",
        language: "pt_BR",
        status: null,
        categoria: null,
        qualidade: { de: "UNKNOWN", para: "GREEN" },
      },
      {
        name: "n",
        language: "pt_BR",
        status: null,
        categoria: null,
        qualidade: { de: null, para: "GREEN" },
      },
    ]);
    expect(inseridos).toHaveLength(0);
  });

  it("modelo reprovado ⇒ aviso crítico de status", async () => {
    const { admin, inseridos } = bancoFalso();
    const aoMudar = abrirAvisosDasMudancasDosModelos(
      admin,
      { organizationId: "org", channelSessionId: "sess" },
      "waba",
    );
    await aoMudar([
      {
        name: "m",
        language: "pt_BR",
        status: { de: "PENDING", para: "REJECTED", motivo: "INVALID_FORMAT" },
        categoria: null,
        qualidade: null,
      },
    ]);
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({ severity: "critical" });
  });
});

describe("verificar a qualidade do número", () => {
  const sessao = (metadata: Record<string, unknown> | null) => ({
    id: "sess",
    organizationId: "org",
    metadata,
  });
  const agora = { quality: "YELLOW", limit: "TIER_1K", telefone: "+55 11 93623-3390" };

  it("primeira consulta só REGISTRA o estado: sem aviso, sem enxurrada", async () => {
    const { admin, inseridos, atualizados } = bancoFalso();
    expect(await verificarQualidadeDoNumero(admin, sessao({ ai_gate: "allowlist" }), agora)).toBe(
      "registrado",
    );
    expect(inseridos).toHaveLength(0);
    // O metadata que já existia é preservado: só a chave nova entra.
    expect(atualizados[0]).toEqual({
      metadata: {
        ai_gate: "allowlist",
        qualidade_oficial: { quality: "YELLOW", limit: "TIER_1K" },
      },
    });
  });

  it("mudou desde a última consulta ⇒ avisa e guarda o novo estado", async () => {
    const { admin, inseridos, atualizados } = bancoFalso();
    const antes = { qualidade_oficial: { quality: "GREEN", limit: "TIER_1K" } };
    expect(await verificarQualidadeDoNumero(admin, sessao(antes), agora)).toBe("avisou");
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({
      kind: "channel_number_alert",
      severity: "warn",
      ref_id: "sess",
    });
    expect(atualizados).toHaveLength(1);
  });

  it("igual à última consulta ⇒ nem avisa nem escreve no banco", async () => {
    const { admin, inseridos, atualizados } = bancoFalso();
    const antes = { qualidade_oficial: { quality: "YELLOW", limit: "TIER_1K" } };
    expect(await verificarQualidadeDoNumero(admin, sessao(antes), agora)).toBe("sem_mudanca");
    expect(inseridos).toHaveLength(0);
    expect(atualizados).toHaveLength(0);
  });
});
