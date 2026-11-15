"""
Brygga mellan Innehav och Morningstar (Analytics Lab / morningstar_data).

Läser ett JSON-kommando från stdin och skriver ett JSON-svar till stdout. Anropas av servern
(server/morningstar.ts) med MD_AUTH_TOKEN satt i miljön. Används inte direkt av användare.

Kommandon:
  {"cmd": "ping"}
  {"cmd": "lookup",   "isins": ["SE0000115446", ...]}
  {"cmd": "describe", "sec_ids": ["0P0000A6H8", ...]}
  {"cmd": "prices",   "sec_ids": [...], "start": "2026-01-01", "end": "2026-11-15"}

Datapunkts-id kan ändras via miljövariabler om LRF:s Morningstar-abonnemang använder andra.
"""
import json
import math
import os
import sys
import warnings

warnings.filterwarnings("ignore")

DP_PRICE = os.getenv("MS_DP_PRICE", "HS538")        # Daily Price (aktier och fonders NAV), tidsserie
DP_CLOSE = os.getenv("MS_DP_CLOSE", "HS377")        # Daily Closing Price (aktier), reserv
DP_NAME = os.getenv("MS_DP_NAME", "OS01W")          # Name
DP_CURRENCY = os.getenv("MS_DP_CURRENCY", "LS05M")  # Base Currency
DP_SECTOR = os.getenv("MS_DP_SECTOR", "LA03Z")      # Morningstar Sector (aktier)
DP_CATEGORY = os.getenv("MS_DP_CATEGORY", "OF003")  # Morningstar Category (fonder)
DP_DOMICILE = os.getenv("MS_DP_DOMICILE", "LS017")  # Domicile
DP_ISIN = os.getenv("MS_DP_ISIN", "OS05J")          # ISIN


def out(obj):
    sys.stdout.write(json.dumps(obj, default=str))
    sys.stdout.flush()


def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def records(df):
    return [{k: clean(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def col(row, *names):
    """Hämtar första befintliga kolumn (kolumnnamn varierar mellan versioner)."""
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n]
    return None


def main():
    req = json.loads(sys.stdin.read() or "{}")
    cmd = req.get("cmd")
    try:
        import morningstar_data as md  # noqa: E402 – kräver MD_AUTH_TOKEN vid import
        from morningstar_data.direct import InvestmentIdentifier, TimeSeriesFormat
    except Exception as e:  # paket saknas eller ogiltig nyckel
        out({"ok": False, "error": f"Kunde inte läsa in morningstar_data: {e}"})
        return

    try:
        if cmd == "ping":
            # Ett litet riktigt anrop så att nyckel och nätverk verkligen prövas
            md.direct.investments(keyword="Volvo", count=1)
            out({"ok": True, "version": getattr(md, "__version__", "okänd")})

        elif cmd == "lookup":
            result = {}
            for isin in req.get("isins", []):
                try:
                    df = md.direct.investments(investment=InvestmentIdentifier(isin=isin), count=20)
                    result[isin] = [
                        {
                            "sec_id": col(r, "SecId"),
                            "name": col(r, "Name"),
                            "ticker": col(r, "Ticker"),
                            "isin": col(r, "ISIN"),
                            "currency": col(r, "Base Currency"),
                            "exchange": col(r, "Exchange"),
                            "country": col(r, "Country"),
                            "security_type": col(r, "Security Type"),
                        }
                        for r in records(df)
                    ]
                except Exception as e:
                    result[isin] = {"error": str(e)}
            errors = [v["error"] for v in result.values() if isinstance(v, dict)]
            if result and len(errors) == len(result) and len(set(errors)) == 1:
                # Samma fel för alla – troligen nyckel eller anslutning, inte enskilda instrument
                out({"ok": False, "error": errors[0]})
                return
            out({"ok": True, "result": result})

        elif cmd == "describe":
            ids = req.get("sec_ids", [])
            dps = [{"datapointId": d} for d in (DP_NAME, DP_CURRENCY, DP_SECTOR, DP_CATEGORY, DP_DOMICILE, DP_ISIN)]
            df = md.direct.get_investment_data(investments=ids, data_points=dps)
            out({"ok": True, "columns": list(df.columns), "rows": records(df)})

        elif cmd == "prices":
            ids = req.get("sec_ids", [])
            start, end = req["start"], req["end"]
            rows = []
            for dp in (DP_PRICE, DP_CLOSE):
                missing = [i for i in ids if not any(r["sec_id"] == i for r in rows)]
                if not missing:
                    break
                df = md.direct.get_investment_data(
                    investments=missing,
                    data_points=[{"datapointId": dp, "isTsdp": True, "startDate": start, "endDate": end, "frequency": "daily"}],
                    time_series_format=TimeSeriesFormat.LONG_WITHOUT_NAME,
                )
                for r in records(df):
                    # Långt format: Id, Date, <värdekolumn>
                    sec = col(r, "Id", "SecId")
                    date = col(r, "Date", "date")
                    vals = [v for k, v in r.items() if k not in ("Id", "SecId", "Date", "date", "Name") and isinstance(v, (int, float))]
                    if sec and date and vals:
                        rows.append({"sec_id": str(sec).split(";")[0], "date": str(date)[:10], "price": vals[0], "datapoint": dp})
            out({"ok": True, "rows": rows})

        else:
            out({"ok": False, "error": f"Okänt kommando: {cmd}"})
    except Exception as e:
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
