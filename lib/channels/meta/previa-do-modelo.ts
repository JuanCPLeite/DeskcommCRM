/** Os textos do modelo (cabeçalho, corpo, rodapé, botões), achatados — inclui os de dentro de card de carrossel. */
export function textPreviews(components: unknown): Array<{ onde: string; text: string }> {
  const out: Array<{ onde: string; text: string }> = [];
  const visita = (lista: unknown, prefixo: string) => {
    if (!Array.isArray(lista)) return;
    for (const c of lista as Array<Record<string, unknown>>) {
      const tipo = String(c.type ?? "").toUpperCase();
      if (Array.isArray(c.cards)) {
        (c.cards as Array<Record<string, unknown>>).forEach((card, i) =>
          visita(card.components, `card ${i + 1} › `),
        );
        continue;
      }
      if (tipo === "BUTTONS" && Array.isArray(c.buttons)) {
        const rotulos = (c.buttons as Array<Record<string, unknown>>)
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .filter((x) => x.length > 0);
        if (rotulos.length > 0) out.push({ onde: `${prefixo}botões`, text: rotulos.join("  ·  ") });
        continue;
      }
      // Todo texto aparece, com ou sem variável: a tela é o ESPELHO do modelo da Meta.
      // (Antes só saía o texto com `{{n}}`, e um modelo sem variável aparecia só pelo nome.)
      const texto = typeof c.text === "string" ? c.text : "";
      if (texto.length === 0) continue;
      const onde = tipo === "HEADER" ? "cabeçalho" : tipo === "FOOTER" ? "rodapé" : "corpo";
      out.push({ onde: `${prefixo}${onde}`, text: texto });
    }
  };
  visita(components, "");
  return out;
}
