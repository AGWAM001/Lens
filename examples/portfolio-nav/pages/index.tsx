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
}

export default function PortfolioNav() {
  const [address, setAddress] = useState('')
  const [rows, setRows] = useState<NavRow[]>([])
  const [totalNav, setTotalNav] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const LENS_URL = process.env.NEXT_PUBLIC_LENS_URL ?? 'http://localhost:3000'
  const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon.stellar.org'

  async function fetchNav() {
    if (!address.trim()) return
    setLoading(true)
    setError(null)
    setRows([])
    setTotalNav(null)

    try {
      const horizonResp = await fetch(`${HORIZON_URL}/accounts/${address.trim()}`)
      if (!horizonResp.ok) throw new Error('Account not found on Horizon')
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
          if (b.asset_code === 'XLM') {
            // Fetch XLM/USDC price from Lens with full decimal precision
            try {
              const priceResp = await fetch(`${LENS_URL}/price/XLM/USDC`, {
                headers: { 'x-decimal-format': 'string' },
              })
              if (priceResp.ok) {
                const data = await priceResp.json()
                const price = parseFloat(data.price)
                return { asset: 'XLM', balance: bal, price, value: bal * price }
              }
            } catch {}
            return { asset: 'XLM', balance: bal, price: null, value: null }
          }

          try {
            const priceResp = await fetch(`${LENS_URL}/price/${b.asset_code}/USDC`, {
              headers: { 'x-decimal-format': 'string' },
            })
            if (priceResp.ok) {
              const data = await priceResp.json()
              const price = parseFloat(data.price)
              return { asset: b.asset_code, balance: bal, price, value: bal * price }
            }
          } catch {}
          return { asset: b.asset_code, balance: bal, price: null, value: null }
        })
      )

      setRows(navRows)
      const total = navRows.reduce((sum, r) => sum + (r.value ?? 0), 0)
      setTotalNav(total)
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ fontFamily: 'monospace', maxWidth: 700, margin: '40px auto', padding: '0 16px' }}>
      <h1>Stellar Portfolio NAV</h1>
      <p style={{ color: '#555' }}>Enter a Stellar address to compute its net asset value using Lens prices.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          style={{ flex: 1, padding: '8px 12px', fontFamily: 'monospace', fontSize: 13 }}
          placeholder="G... Stellar address"
          value={address}
          onChange={e => setAddress(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && fetchNav()}
        />
        <button
          onClick={fetchNav}
          disabled={loading}
          style={{ padding: '8px 16px', cursor: loading ? 'wait' : 'pointer' }}
        >
          {loading ? 'Loading…' : 'Fetch NAV'}
        </button>
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {rows.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ccc', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Asset</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Balance</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Price (USDC)</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Value (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.asset} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '6px 8px' }}>{r.asset}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.balance.toFixed(7)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {r.price !== null ? r.price.toFixed(6) : '—'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {r.value !== null ? r.value.toFixed(2) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 16, fontSize: 14 }}>
            <strong>Total NAV:</strong>{' '}
            {totalNav !== null ? `$${totalNav.toFixed(2)} USDC` : 'Partial (some prices unavailable)'}
          </p>
        </>
      )}
    </main>
  )
}
