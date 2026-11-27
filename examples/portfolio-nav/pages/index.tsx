import { useState } from 'react'

interface AssetBalance {
  asset_code: string
  asset_issuer: string | null
  balance: string
}

interface NavRow {
  asset: string
  balance: number
  price: number | null
  value: number | null
  error?: string
}

export default function PortfolioNav() {
  const [address, setAddress] = useState('')
  const [rows, setRows] = useState<NavRow[]>([])
  const [totalNav, setTotalNav] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Lens base URL — must match your running instance (default port 3002). */
  const LENS_URL = (process.env.NEXT_PUBLIC_LENS_URL ?? 'http://localhost:3002').replace(/\/+$/, '')
  const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon.stellar.org'
  /** Optional API key for authenticated Lens instances. See README for security note. */
  const LENS_KEY = process.env.NEXT_PUBLIC_LENS_KEY ?? ''
  /** Network passed to Lens so it matches the Horizon network being queried. */
  const NETWORK = process.env.NEXT_PUBLIC_NETWORK ?? 'mainnet'

  function lensHeaders(): HeadersInit {
    const h: Record<string, string> = { 'x-decimal-format': 'string' }
    if (LENS_KEY) h['Authorization'] = `Bearer ${LENS_KEY}`
    return h
  }

  async function fetchNav() {
    if (!address.trim()) return
    setLoading(true)
    setError(null)
    setRows([])
    setTotalNav(null)

    try {
      const horizonResp = await fetch(`${HORIZON_URL}/accounts/${address.trim()}`)
      if (!horizonResp.ok) throw new Error(`Account not found on Horizon (HTTP ${horizonResp.status})`)
      const account = await horizonResp.json()

      const balances: AssetBalance[] = (account.balances ?? []).filter(
        (b: any) => parseFloat(b.balance) > 0
      ).map((b: any) => ({
        asset_code: b.asset_type === 'native' ? 'XLM' : b.asset_code,
        asset_issuer: b.asset_type === 'native' ? null : b.asset_issuer,
        balance: b.balance,
      }))

      const navRows: NavRow[] = await Promise.all(
        balances.map(async (b) => {
          const bal = parseFloat(b.balance)
          const pair = `${b.asset_code}/USDC`
          try {
            const priceResp = await fetch(
              `${LENS_URL}/v1/price/${pair}?network=${NETWORK}`,
              { headers: lensHeaders() }
            )
            if (!priceResp.ok) {
              return { asset: b.asset_code, balance: bal, price: null, value: null, error: `HTTP ${priceResp.status}` }
            }
            const data = await priceResp.json()
            const price = parseFloat(data.price)
            if (isNaN(price)) {
              return { asset: b.asset_code, balance: bal, price: null, value: null, error: 'Invalid price in response' }
            }
            return { asset: b.asset_code, balance: bal, price, value: bal * price }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Network error'
            return { asset: b.asset_code, balance: bal, price: null, value: null, error: msg }
          }
        })
      )

      setRows(navRows)
      const total = navRows.reduce((sum, r) => sum + (r.value ?? 0), 0)
      setTotalNav(total)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Portfolio NAV</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Paste your Stellar public key (G…)"
          style={{ flex: 1, padding: '8px 12px' }}
        />
        <button onClick={fetchNav} disabled={loading}>
          {loading ? 'Loading…' : 'Value'}
        </button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Asset</th><th align="right">Balance</th>
              <th align="right">Price</th><th align="right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset}>
                <td>{r.asset}</td>
                <td align="right">{r.balance.toFixed(4)}</td>
                <td align="right">{r.price != null ? `$${r.price.toFixed(6)}` : <span title={r.error}>—</span>}</td>
                <td align="right">{r.value != null ? `$${r.value.toFixed(2)}` : <span style={{ color: '#999' }}>{r.error ?? 'N/A'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totalNav != null && <h2>Total NAV: ${totalNav.toFixed(2)}</h2>}
    </main>
  )
}
