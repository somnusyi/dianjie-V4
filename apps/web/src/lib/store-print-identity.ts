export type PrintableStore = {
  name: string
  no?: string | null
  brandCode?: string | null
}

const BRAND_NAMES: Record<string, string> = {
  DIANJIE: '滇界',
  LANCANGYAO: '澜苍谣',
  PAOPAO_ISLAND: 'PaoPao岛',
}

/** Keep the full store name for the receiver, and show brand and branch separately. */
export function storePrintIdentity(store: PrintableStore) {
  const fullName = store.name.trim()
  const prefix = /^(滇界|澜苍谣|澜沧遥|PaoPao岛)[·\-]/.exec(fullName)?.[1]
  const brand = BRAND_NAMES[store.brandCode || ''] || (prefix === '澜沧遥' ? '澜苍谣' : prefix) || '未确认'
  const branch = /[（(]([^()（）]+)[）)]$/.exec(fullName)?.[1]?.trim()
    || (prefix ? fullName.slice(prefix.length + 1).trim() : fullName)
  return { brand, branch, fullName, no: store.no || '—' }
}
