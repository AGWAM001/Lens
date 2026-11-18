//! Lens SEP-40 price feed contract.
//!
//! SEP-40 ("Oracle Consumer Interface") standardises how a Soroban contract
//! READS a price feed. It deliberately says nothing about how a provider writes
//! one ("The exact mechanism of data reporting mechanism utilized by an oracle
//! is out of scope of this SEP" — SEP-40 § Design Rationale / Data Reporting).
//! So this contract has two halves:
//!
//! 1. the `PriceFeedTrait` surface from the spec — `base`, `assets`, `decimals`,
//!    `resolution`, `price`, `prices`, `lastprice` — exactly as declared, so any
//!    SEP-40 consumer can read a Lens price without an adapter contract;
//! 2. a provider-side `report` write, authenticated by the Lens publisher key,
//!    which is the only way data gets in.
//!
//! Prices are stored as `i128` scaled by `decimals()`: the real value is
//! `price / 10^decimals` (SEP-40 § Design Rationale). Timestamps are unix
//! seconds trimmed to `resolution()`, so consumers can compare them against the
//! current ledger time to judge staleness — and Lens trims them on the way in,
//! which `report` then re-checks, so a mis-scaled write cannot land.
//!
//! Provenance: every report carries the list of venues behind the number
//! (`SDEX`, `AMM`, `aquarius_amm`, …). The source count is derived from that
//! list rather than passed in, so the contract can never record a price that
//! claims more sources than it can name.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Vec,
};

/// SEP-40 §Interface: a Stellar asset is identified by its Stellar Asset
/// Contract address (issuer-qualified by construction); anything else — and
/// native XLM, which has no asset contract — is identified by a symbol the
/// oracle defines.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 §Interface: "Price data for an asset at a specific timestamp".
/// Fields are `pub` (the spec's snippet omits that, and private fields cannot
/// be read by a consumer contract).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceData {
    /// Scaled by `decimals()`: real price = `price / 10^decimals`.
    pub price: i128,
    /// Unix seconds, trimmed to `resolution()`.
    pub timestamp: u64,
}

/// What Lens actually pushed, and what it was made of. Consumer contracts do
/// not need this to read a price (SEP-40 is enough for that), but they need it
/// to answer "how fresh is this, and which venues produced it" — the same two
/// guarantees the HTTP API makes about the aggregate it serves.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub price: i128,
    /// SEP-40 feed timestamp (trimmed to `resolution()`).
    pub timestamp: u64,
    /// Ledger close time of the on-chain write — when the feed value became
    /// available, as opposed to when the market tick it describes occurred.
    pub reported_at: u64,
    /// Ledger the write landed in.
    pub reported_ledger: u32,
    /// Number of venues behind the aggregate; always `venues.len()`.
    pub source_count: u32,
    /// Which venues those were.
    pub venues: Vec<Symbol>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` has already run. Config is immutable on purpose: SEP-40
    /// says decimals/resolution "should never change" once deployed.
    AlreadyInitialized = 1,
    NonPositivePrice = 2,
    /// A feed timestamp that is not a whole number of resolutions would break
    /// the trimming rule every consumer relies on.
    TimestampNotAligned = 3,
    /// Reports must move forward; an out-of-order write cannot rewrite history.
    NotNewer = 4,
    /// The publisher's clock is ahead of the ledger, or the write is replayed
    /// from far in the past. Either way the value is not publishable.
    TimestampInFuture = 5,
    /// A price with no venue behind it is worse than no price.
    NoVenues = 6,
    /// Bounds the per-asset storage footprint.
    TooManyVenues = 7,
    /// `decimals` or `resolution` was zero; both are load-bearing for every
    /// price and timestamp in the feed, so they are refused rather than stored.
    InvalidConfig = 8,
}

#[contracttype]
enum DataKey {
    Admin,
    Publisher,
    Base,
    Decimals,
    Resolution,
    /// Every asset that has ever been reported, in first-seen order, so
    /// `assets()` can enumerate the feed.
    Assets,
    /// Per-asset history, newest first.
    History(Asset),
    /// Per-asset last known price (SEP-40 `lastprice`).
    Last(Asset),
    /// Per-asset last report with its provenance.
    LastReport(Asset),
}

/// Price records kept per asset. `prices()` reads from this, and it is trimmed
/// on every write so the feed cannot grow without bound.
const MAX_HISTORY: u32 = 64;
/// Venue names accepted in one report. Well above the number of venues Lens
/// aggregates today, and low enough to keep a report's storage small.
const MAX_VENUES: u32 = 16;
/// Persistent-entry TTL policy: extend when an entry is within `THRESHOLD`
/// ledgers of expiry, by `BUMP` ledgers (roughly 4 days at ~5 s per ledger).
const TTL_THRESHOLD: u32 = 5_000;
const TTL_BUMP: u32 = 40_000;

#[contract]
pub struct Sep40OracleContract;

#[contractimpl]
impl Sep40OracleContract {
    // ── Admin ────────────────────────────────────────────────────────────────

    /// One-shot configuration, called by the deployer. `base` is the asset every
    /// feed is denominated in (SEP-40 § Specification: "all price feeds … in
    /// the base asset"), `decimals` the scale of `PriceData.price`, and
    /// `resolution` the timeframe feeds are trimmed to.
    ///
    /// Never callable twice: SEP-40 requires these values to be stable once
    /// deployed, because consumers cannot be expected to react to a change.
    pub fn initialize(
        env: Env,
        admin: Address,
        base: Asset,
        decimals: u32,
        resolution: u32,
    ) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if decimals == 0 || resolution == 0 {
            // A zero resolution would make every timestamp check divide by zero
            // and a zero decimal count would silently round every price to an
            // integer, so both are refused rather than stored.
            return Err(Error::InvalidConfig);
        }

        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Base, &base);
        storage.set(&DataKey::Decimals, &decimals);
        storage.set(&DataKey::Resolution, &resolution);
        storage.set(&DataKey::Assets, &Vec::<Asset>::new(&env));
        storage.extend_ttl(TTL_THRESHOLD, TTL_BUMP);
        Ok(())
    }

    /// Point the feed at a hot publisher key. The publisher signs `report`;
    /// the admin key stays cold and only ever signs `initialize`,
    /// `set_publisher` and `upgrade`. Unset, `report` falls back to the admin.
    pub fn set_publisher(env: Env, publisher: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Publisher, &publisher);
    }

    /// Swap the implementation without changing the contract address, which
    /// SEP-40 requires ("it must be upgradeable without changing the contract
    /// address. Smart contract consumers should only be expected to change
    /// their price feed aggregator address if they would like to change oracle
    /// providers").
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_admin(&env);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Publish one aggregate value for one asset. This is the provider half —
    /// out of SEP-40's scope, so its shape is Lens's own.
    ///
    /// `timestamp` must already be trimmed to `resolution()` (Lens does that
    /// when it builds the report; the contract re-checks it so a consumer can
    /// take the trimming as a guarantee rather than a convention).
    pub fn report(
        env: Env,
        asset: Asset,
        price: i128,
        timestamp: u64,
        venues: Vec<Symbol>,
    ) -> Result<(), Error> {
        Self::require_publisher(&env);

        if price <= 0 {
            return Err(Error::NonPositivePrice);
        }
        if venues.is_empty() {
            return Err(Error::NoVenues);
        }
        if venues.len() > MAX_VENUES {
            return Err(Error::TooManyVenues);
        }

        let resolution: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Resolution)
            .ok_or(Error::TimestampNotAligned)?;
        if timestamp % resolution as u64 != 0 {
            return Err(Error::TimestampNotAligned);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }

        let data = PriceData { price, timestamp };
        if let Some(last) = Self::read_last(&env, &asset) {
            if timestamp <= last.timestamp {
                return Err(Error::NotNewer);
            }
        }

        // History is newest-first so `prices(records)` and `price(timestamp)`
        // read from the front, and the trim happens at the back.
        let mut history = Self::read_history(&env, &asset);
        history.push_front(data.clone());
        while history.len() > MAX_HISTORY {
            history.pop_back();
        }

        let report = Report {
            price,
            timestamp,
            reported_at: env.ledger().timestamp(),
            reported_ledger: env.ledger().sequence(),
            source_count: venues.len(),
            venues,
        };

        let history_key = DataKey::History(asset.clone());
        let last_key = DataKey::Last(asset.clone());
        let report_key = DataKey::LastReport(asset.clone());
        let storage = env.storage().persistent();
        storage.set(&history_key, &history);
        storage.set(&last_key, &data);
        storage.set(&report_key, &report);
        storage.extend_ttl(&history_key, TTL_THRESHOLD, TTL_BUMP);
        storage.extend_ttl(&last_key, TTL_THRESHOLD, TTL_BUMP);
        storage.extend_ttl(&report_key, TTL_THRESHOLD, TTL_BUMP);

        // Enumerate this asset from `assets()` from now on.
        let mut assets: Vec<Asset> = env
            .storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or(Vec::new(&env));
        if !Self::contains_asset(&assets, &asset) {
            assets.push_back(asset.clone());
            env.storage().instance().set(&DataKey::Assets, &assets);
        }

        env.events().publish(
            ("lens_oracle", symbol_short!("report")),
            (asset.clone(), price, timestamp),
        );
        Ok(())
    }

    // ── SEP-40 PriceFeedTrait ────────────────────────────────────────────────

    /// The asset every price in this feed is denominated in.
    pub fn base(env: Env) -> Asset {
        env.storage()
            .instance()
            .get(&DataKey::Base)
            .expect("oracle is not initialized")
    }

    /// All assets this feed quotes.
    pub fn assets(env: Env) -> Vec<Asset> {
        env.storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or(Vec::new(&env))
    }

    /// Scale of `PriceData.price` for every asset in this feed.
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .expect("oracle is not initialized")
    }

    /// Default tick period, in seconds, that feed timestamps are trimmed to.
    pub fn resolution(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Resolution)
            .expect("oracle is not initialized")
    }

    /// The feed value in effect at `timestamp` — the newest record at or before
    /// it, or `None`.
    ///
    /// SEP-40 phrases this as "price information for a given point in time,
    /// under condition that the historical data for a requested timestamp is
    /// available". A deviation-triggered feed is deliberately non-uniform, so
    /// an exact timestamp is usually absent; nearest-at-or-before is the
    /// extrapolation the spec asks an oracle to present instead. Unknown assets
    /// and timestamps older than the retained history return `None` rather than
    /// erroring, per the spec's instruction to delegate error handling to the
    /// consumer.
    pub fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        let history = Self::read_history(&env, &asset);
        let mut best: Option<PriceData> = None;
        for record in history.iter() {
            if record.timestamp <= timestamp {
                best = Some(record);
                break;
            }
        }
        best
    }

    /// The last `records` prices for an asset, newest first. `None` when the
    /// asset has no history, and `None` for `records == 0`, which is not a
    /// question the feed can answer. Fewer than `records` may be returned when
    /// the feed has not published that many values yet, or when `records`
    /// exceeds the retained history (`MAX_HISTORY`).
    pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        // A request for zero records is invalid input, and SEP-40 asks the
        // oracle to hand invalid input back as `None` rather than as a value
        // that looks like an answer.
        if records == 0 {
            return None;
        }
        let history = Self::read_history(&env, &asset);
        if history.is_empty() {
            return None;
        }
        // Asking for more than the feed has kept is not an error: the feed
        // answers with everything it has, newest first.
        let take = if records > history.len() { history.len() } else { records };
        let mut out = Vec::<PriceData>::new(&env);
        for i in 0..take {
            out.push_back(history.get(i)?);
        }
        Some(out)
    }

    /// The most recent price for an asset.
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        Self::read_last(&env, &asset)
    }

    // ── Lens-specific reads (beyond SEP-40) ──────────────────────────────────

    /// Full provenance of the last write: when it landed on chain, in which
    /// ledger, and which venues produced the value. A consumer that wants to
    /// hold the same bar as the HTTP API's `stale` / source fields reads this.
    pub fn last_report(env: Env, asset: Asset) -> Option<Report> {
        env.storage().persistent().get(&DataKey::LastReport(asset))
    }

    // ── Internals ────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("oracle is not initialized");
        admin.require_auth();
    }

    /// `report` is authorized by the publisher when one has been set, and by
    /// the admin otherwise. Exactly one address authorizes a write, so there is
    /// no ambiguity about which key the operator has to hold.
    fn require_publisher(env: &Env) {
        let storage = env.storage().instance();
        let publisher: Option<Address> = storage.get(&DataKey::Publisher);
        match publisher {
            Some(publisher) => publisher.require_auth(),
            None => Self::require_admin(env),
        }
    }

    fn read_last(env: &Env, asset: &Asset) -> Option<PriceData> {
        let key = DataKey::Last(asset.clone());
        let storage = env.storage().persistent();
        let data: Option<PriceData> = storage.get(&key);
        if data.is_some() {
            storage.extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
        }
        data
    }

    fn read_history(env: &Env, asset: &Asset) -> Vec<PriceData> {
        env.storage()
            .persistent()
            .get(&DataKey::History(asset.clone()))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn contains_asset(assets: &Vec<Asset>, asset: &Asset) -> bool {
        for existing in assets.iter() {
            if equal_assets(&existing, asset) {
                return true;
            }
        }
        false
    }
}

/// Two `Asset`s are the same asset when they are the same variant holding the
/// same value. Written as a match rather than derived: `Asset` is the type the
/// spec pins, and comparing the two payload kinds directly is all the identity
/// check the registry needs.
fn equal_assets(a: &Asset, b: &Asset) -> bool {
    match (a, b) {
        (Asset::Stellar(x), Asset::Stellar(y)) => x == y,
        (Asset::Other(x), Asset::Other(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::InvokeError;
    use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger as _};

    const DECIMALS: u32 = 14;
    const RESOLUTION: u32 = 60;
    /// Ledger time the test env starts at, so a report can be "now".
    const NOW: u64 = 1_760_000_040;

    fn sym(env: &Env, name: &str) -> Symbol {
        Symbol::new(env, name)
    }

    fn venues(env: &Env, names: &[&str]) -> Vec<Symbol> {
        let mut out = Vec::new(env);
        for name in names {
            out.push_back(sym(env, name));
        }
        out
    }

    /// XLM quoted in USDC, as the SEP-40 `Other(Symbol)` form.
    fn xlm(env: &Env) -> Asset {
        Asset::Other(sym(env, "XLM"))
    }

    struct Feed {
        env: Env,
        client: Sep40OracleContractClient<'static>,
        admin: Address,
        publisher: Address,
    }

    fn feed(timestamp: u64) -> Feed {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(timestamp);
        let contract_id = env.register(Sep40OracleContract, ());
        let client = Sep40OracleContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        client.initialize(&admin, &Asset::Other(sym(&env, "USDC")), &DECIMALS, &RESOLUTION);
        client.set_publisher(&publisher);
        Feed { env, client, admin, publisher }
    }

    /// Publish at `timestamp`, taking the ledger clock with it. A real publisher
    /// can only report a tick the ledger has already reached (`report` refuses a
    /// timestamp ahead of ledger time), so a test that walks forward through the
    /// day has to walk the clock forward too.
    fn report_at(f: &Feed, asset: &Asset, price: i128, timestamp: u64, names: &[&str]) {
        f.env.ledger().set_timestamp(timestamp);
        f.client
            .report(asset, &price, &timestamp, &venues(&f.env, names));
    }

    #[test]
    fn initialize_publishes_the_feed_parameters() {
        let f = feed(NOW);
        assert_eq!(f.client.decimals(), DECIMALS);
        assert_eq!(f.client.resolution(), RESOLUTION);
        assert_eq!(f.client.base(), Asset::Other(sym(&f.env, "USDC")));
        // Nothing reported yet, so nothing is quoted.
        assert_eq!(f.client.assets().len(), 0);
    }

    #[test]
    fn initialize_cannot_run_twice() {
        let f = feed(NOW);
        let result = f.client.try_initialize(
            &f.admin,
            &Asset::Other(sym(&f.env, "EUR")),
            &DECIMALS,
            &RESOLUTION,
        );
        assert_eq!(result.err(), Some(Ok(Error::AlreadyInitialized)));
    }

    #[test]
    fn zero_resolution_or_decimals_is_refused() {
        // A zero resolution makes every timestamp check divide by zero; a zero
        // decimal count silently rounds every price to an integer.
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Sep40OracleContract, ());
        let client = Sep40OracleContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let zero_resolution =
            client.try_initialize(&admin, &Asset::Other(sym(&env, "USDC")), &DECIMALS, &0);
        assert_eq!(zero_resolution.err(), Some(Ok(Error::InvalidConfig)));
        let zero_decimals =
            client.try_initialize(&admin, &Asset::Other(sym(&env, "USDC")), &0, &RESOLUTION);
        assert_eq!(zero_decimals.err(), Some(Ok(Error::InvalidConfig)));
    }

    #[test]
    fn a_reported_price_is_readable_through_sep_40() {
        let f = feed(NOW);
        // 0.025 USDC per XLM at 14 decimals.
        let price: i128 = 250_000_000_000_000;
        f.client
            .report(&xlm(&f.env), &price, &NOW, &venues(&f.env, &["SDEX", "AMM"]));

        let last = f.client.lastprice(&xlm(&f.env)).expect("price");
        assert_eq!(last.price, price);
        assert_eq!(last.timestamp, NOW);

        assert_eq!(f.client.assets().len(), 1);
        let historical = f.client.price(&xlm(&f.env), &NOW).expect("price at now");
        assert_eq!(historical.price, price);
        let history = f.client.prices(&xlm(&f.env), &10).expect("history");
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn last_report_names_the_venues_behind_the_number() {
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        f.client.report(
            &xlm(&f.env),
            &price,
            &NOW,
            &venues(&f.env, &["SDEX", "AMM", "aquarius_amm"]),
        );

        let report = f.client.last_report(&xlm(&f.env)).expect("report");
        assert_eq!(report.source_count, 3);
        assert_eq!(report.venues.len(), 3);
        assert_eq!(report.venues.get(2).unwrap(), sym(&f.env, "aquarius_amm"));
        // The write landed in this ledger, at this close time.
        assert_eq!(report.reported_at, NOW);
        assert_eq!(report.reported_ledger, f.env.ledger().sequence());
    }

    #[test]
    fn history_is_newest_first() {
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        for offset in [0_u64, 60, 120] {
            report_at(&f, &xlm(&f.env), price, NOW + offset, &["SDEX"]);
        }
        let history = f.client.prices(&xlm(&f.env), &10).expect("history");
        assert_eq!(history.len(), 3);
        assert_eq!(history.get(0).unwrap().timestamp, NOW + 120);
        assert_eq!(history.get(2).unwrap().timestamp, NOW);
    }

    #[test]
    fn price_at_returns_the_nearest_value_at_or_before() {
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        f.client
            .report(&xlm(&f.env), &price, &NOW, &venues(&f.env, &["SDEX"]));
        // A deviation-triggered feed has no record at every resolution tick;
        // asking for a later one still yields the value in effect.
        assert_eq!(f.client.price(&xlm(&f.env), &(NOW + 300)).unwrap().timestamp, NOW);
        // …and one from before the first report has nothing in effect yet.
        assert_eq!(f.client.price(&xlm(&f.env), &(NOW - 60)), None);
    }

    #[test]
    fn an_unquoted_asset_reads_as_none_rather_than_an_error() {
        // SEP-40: "a contract should return None on such function calls in
        // order to delegate error handling logic directly to consumer
        // contracts".
        let f = feed(NOW);
        let eur = Asset::Other(sym(&f.env, "EUR"));
        assert_eq!(f.client.lastprice(&eur), None);
        assert_eq!(f.client.prices(&eur, &5), None);
        assert_eq!(f.client.price(&eur, &NOW), None);
        assert_eq!(f.client.last_report(&eur), None);
    }

    #[test]
    fn a_report_that_does_not_move_the_feed_forward_is_rejected() {
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        f.client
            .report(&xlm(&f.env), &price, &NOW, &venues(&f.env, &["SDEX"]));

        let older = f.client.try_report(
            &xlm(&f.env),
            &(price + 1),
            &(NOW - 60),
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(older.err(), Some(Ok(Error::NotNewer)));

        // A replay of the same tick is refused for the same reason, so a
        // retried publish cannot rewrite the value consumers already read.
        let same = f.client.try_report(
            &xlm(&f.env),
            &price,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(same.err(), Some(Ok(Error::NotNewer)));
    }

    #[test]
    fn a_feed_timestamp_must_be_trimmed_to_the_resolution() {
        // SEP-40 defines the timestamp as floor(unix_now() / resolution) *
        // resolution. Enforcing it here means a consumer can treat trimming as
        // a guarantee instead of a convention.
        let f = feed(NOW);
        let result = f.client.try_report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &(NOW + 1),
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(result.err(), Some(Ok(Error::TimestampNotAligned)));
    }

    #[test]
    fn a_timestamp_from_the_future_is_rejected() {
        // A publisher with a clock ahead of the ledger would otherwise hand
        // consumers a price that never looks stale.
        let f = feed(NOW);
        let result = f.client.try_report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &(NOW + 600),
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(result.err(), Some(Ok(Error::TimestampInFuture)));
    }

    #[test]
    fn a_price_with_no_venue_or_no_magnitude_is_rejected() {
        let f = feed(NOW);
        let none = f.client.try_report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &NOW,
            &Vec::<Symbol>::new(&f.env),
        );
        assert_eq!(none.err(), Some(Ok(Error::NoVenues)));

        let zero = f.client.try_report(
            &xlm(&f.env),
            &0,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(zero.err(), Some(Ok(Error::NonPositivePrice)));

        let negative = f.client.try_report(
            &xlm(&f.env),
            &-1,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(negative.err(), Some(Ok(Error::NonPositivePrice)));
    }

    #[test]
    fn more_venues_than_the_feed_will_store_is_rejected() {
        let f = feed(NOW);
        let names: [&str; 17] = [
            "SDEX", "AMM", "a_1", "a_2", "a_3", "a_4", "a_5", "a_6", "a_7", "a_8", "a_9",
            "b_1", "b_2", "b_3", "b_4", "b_5", "b_6",
        ];
        let result = f.client.try_report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &NOW,
            &venues(&f.env, &names),
        );
        assert_eq!(result.err(), Some(Ok(Error::TooManyVenues)));
    }

    #[test]
    fn history_stays_bounded() {
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        let writes = MAX_HISTORY + 25;
        for i in 0..writes {
            let timestamp = NOW + 60 * (i as u64) + 60;
            report_at(&f, &xlm(&f.env), price, timestamp, &["SDEX"]);
        }
        assert_eq!(f.client.prices(&xlm(&f.env), &1_000).unwrap().len(), MAX_HISTORY);
        // The oldest retained record is the first one still inside the window:
        // everything older than the newest `MAX_HISTORY` writes is gone.
        assert_eq!(
            f.client.prices(&xlm(&f.env), &1_000).unwrap().get(MAX_HISTORY - 1).unwrap().timestamp,
            NOW + 60_u64 * (writes - MAX_HISTORY) as u64 + 60
        );
    }

    #[test]
    fn asking_for_more_records_than_exist_returns_what_there_is() {
        let f = feed(NOW);
        f.client.report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(f.client.prices(&xlm(&f.env), &100).unwrap().len(), 1);
        // Zero records is invalid input, so it reads as "nothing", not an error.
        assert_eq!(f.client.prices(&xlm(&f.env), &0), None);
    }

    #[test]
    fn each_quoted_asset_keeps_its_own_history() {
        let f = feed(NOW);
        f.client.report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        let btc = Asset::Other(sym(&f.env, "BTC"));
        f.client.report(
            &btc,
            &60_000_000_000_000_000_000_000,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );

        assert_eq!(f.client.assets().len(), 2);
        assert!(f.client.lastprice(&btc).is_some());
        // A write to one asset cannot disturb another.
        assert_eq!(f.client.prices(&btc, &10).unwrap().len(), 1);
        assert_eq!(f.client.prices(&xlm(&f.env), &10).unwrap().len(), 1);
    }

    #[test]
    fn a_write_without_the_publishers_authorization_does_not_land() {
        // `report` accepts exactly one signer: the publisher address stored in
        // the feed. Turning the env's auth mocking off makes the call carry
        // nobody's authorization, so the write is refused before any of the
        // price rules are reached — and the read surface is untouched.
        let f = feed(NOW);
        f.env.set_auths(&[]);

        let result = f.client.try_report(
            &xlm(&f.env),
            &1_000_000_000_000_000,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        // The refusal comes from the auth layer, not from one of the feed's own
        // rules: a contract error would surface as `Err(Ok(Error::…))`.
        assert_eq!(
            result.err(),
            Some(Err(InvokeError::Abort)),
            "a write without the publisher's authorization must not land"
        );
        assert_eq!(f.client.lastprice(&xlm(&f.env)), None);
        assert_eq!(f.client.assets().len(), 0);
    }

    #[test]
    fn the_publisher_is_the_address_that_signs_a_write() {
        // With auth recording enabled the call still succeeds, but the feed
        // reports *whose* authorization it demanded: the publisher, never the
        // admin and never the signer of the transaction.
        let f = feed(NOW);
        let price: i128 = 1_000_000_000_000_000;
        f.client
            .report(&xlm(&f.env), &price, &NOW, &venues(&f.env, &["SDEX"]));

        let mut auths = f.env.auths();
        assert_eq!(auths.len(), 1, "a report demands exactly one signature");
        let (signer, invocation) = auths.pop().expect("one authorization");
        assert_eq!(signer, f.publisher);
        match invocation.function {
            AuthorizedFunction::Contract((contract, fn_name, _)) => {
                assert_eq!(contract, f.client.address);
                assert_eq!(fn_name, sym(&f.env, "report"));
            }
            _ => panic!("a report is authorized by a contract invocation"),
        }
    }

    #[test]
    fn a_stellar_asset_is_quoted_by_its_asset_contract_address() {
        // SEP-40 represents a Stellar asset by the address of its Stellar Asset
        // Contract, which is what makes the identifier issuer-qualified: two
        // tokens both called USDC are different assets here.
        let f = feed(NOW);
        let usdc = Asset::Stellar(Address::generate(&f.env));
        f.client.report(
            &usdc,
            &40_000_000_000_000,
            &NOW,
            &venues(&f.env, &["SDEX"]),
        );
        assert_eq!(f.client.lastprice(&usdc).unwrap().price, 40_000_000_000_000);
        assert_eq!(f.client.assets().get(0).unwrap(), usdc);
    }

    #[test]
    fn a_second_report_of_the_same_asset_does_not_duplicate_the_registry() {
        let f = feed(NOW);
        for offset in [60_u64, 120] {
            report_at(&f, &xlm(&f.env), 1_000_000_000_000_000, NOW + offset, &["SDEX"]);
        }
        assert_eq!(f.client.assets().len(), 1);
    }
}
