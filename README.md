# ASR Estimator

A small Node.js 24 web app to estimate Azure Site Recovery costs:

- **Monthly ASR cost** = ASR protected instance fee + replica managed disks (Standard SSD or Premium SSD, LRS) + cache storage account share
- **24h Test DR cost** = DR VM compute (PAYG, Linux/Windows) + disk snapshot slice + Standard Public IP

Pricing comes live from the [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices). The cache is warmed at server start for both EUR and USD, across:

- West Europe, North Europe, Italy North, France Central, Sweden Central, Germany West Central

## Run

Requires **Node.js 24+**.

```powershell
cd c:\Users\maestrellie\Downloads\AzureSiteRecovery
npm install
npm start
```

Then open http://localhost:3000.

The first time you launch, the status pill in the top-right shows `prices: warming…` while the retail prices are fetched (one-time, takes ~30–90s depending on bandwidth). When it reads `prices: ready` you can run an estimate.

## How to use

1. Pick **Region**, **Scenario** (on-prem→Azure or Azure→Azure) and **Currency**.
2. Either:
   - Click **Upload RVTools export** (supports `.xlsx` with `vInfo` + `vDisk`, or a single `.csv`), or
   - Click **+ Add VM** to add VMs manually.
3. For each VM, set vCPU, RAM, OS, and disks (size + SSD family). The next disk tier (E*/P*) is shown automatically.
4. A **DR target VM** is suggested using the best-fit recommender (vCPU ≥ source, RAM ≥ source, newest generation preferred). Click any suggestion chip, or type in the combo box to search the full catalog (including specialty SKUs like M/NC/HB).
5. Click **Estimate**. The two totals animate in, with a per-VM breakdown of line items.
6. **Export JSON** to persist the project; **Import JSON** to restore it.

## Files

- [server.js](server.js) — Express bootstrap and routes
- [src/prices.js](src/prices.js) — Retail Prices API client + cache
- [src/diskTiers.js](src/diskTiers.js) — E/P managed-disk SKU table
- [src/vmCatalog.js](src/vmCatalog.js) — curated VM SKU specs (vCPU/RAM/gen)
- [src/recommender.js](src/recommender.js) — best-fit and search
- [src/rvtools.js](src/rvtools.js) — RVTools XLSX/CSV parser
- [src/estimator.js](src/estimator.js) — cost computation
- [public/](public/) — vanilla JS UI + anime.js animations

## Assumptions worth knowing

- **Disk sizing:** rounded UP to the next standard tier (P1…P80 / E1…E80), priced LRS at the monthly tier rate.
- **Cache storage:** sized as `total disk GiB × churn%/day × retention days` (defaults 10% / 3d), priced GPv2 LRS Hot.
- **Test DR disk snapshot:** approximated as `1/30 of monthly tier rate × 24h slice`. This is a rough proxy — Azure actually bills snapshot delta, not the whole disk.
- **Test DR compute:** 24h × hourly PAYG rate for the chosen `armSkuName`, OS-aware (Linux or Windows).
- **Public IP:** Standard Static, 24h × hourly rate, one per VM.
- **ASR scenario:** scenario filter picks the meter best matching "Azure to Azure" vs on-prem→Azure; the per-instance Azure list price for ASR is the same value regardless.
- **All prices are list/PAYG.** Enterprise Agreements, CSP discounts, savings plans, and reserved instances are not modelled.
