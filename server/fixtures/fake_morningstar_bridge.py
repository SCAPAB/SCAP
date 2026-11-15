"""Simulerad Morningstar-brygga för tester – svarar som scripts/morningstar_bridge.py utan nätverk."""
import json, os, sys
req = json.loads(sys.stdin.read() or "{}")
if not os.getenv("MD_AUTH_TOKEN"):
    print(json.dumps({"ok": False, "error": "MD_AUTH_TOKEN saknas"})); sys.exit()
LISTINGS = {
    "SE0000115446": [
        {"sec_id": "0P0000EX2Q", "name": "Volvo AB Class B", "ticker": "0HTP", "isin": "SE0000115446", "currency": "GBP", "exchange": "London Stock Exchange", "country": "Sweden", "security_type": "ST"},
        {"sec_id": "0P0000A6H8", "name": "Volvo AB Class B", "ticker": "VOLV B", "isin": "SE0000115446", "currency": "Swedish Krona", "exchange": "Nasdaq Stockholm", "country": "Sweden", "security_type": "ST"},
        {"sec_id": "0P0000BVSE", "name": "Volvo AB Class B", "ticker": "VOL1", "isin": "SE0000115446", "currency": "EUR", "exchange": "Xetra", "country": "Sweden", "security_type": "ST"},
    ],
}
cmd = req.get("cmd")
if cmd == "ping":
    print(json.dumps({"ok": True, "version": "fake"}))
elif cmd == "lookup":
    print(json.dumps({"ok": True, "result": {i: LISTINGS.get(i, {"error": "Ingen träff"}) for i in req["isins"]}}))
elif cmd == "prices":
    rows = [{"sec_id": s, "date": d, "price": p, "datapoint": "HS538"} for s in req["sec_ids"] if s == "0P0000A6H8"
            for d, p in [("2026-11-12", 324.0), ("2026-11-13", 323.4)]]
    print(json.dumps({"ok": True, "rows": rows}))
elif cmd == "describe":
    print(json.dumps({"ok": True, "rows": [{"Id": req["sec_ids"][0], "Name": "Volvo AB Class B", "Base Currency": "Swedish Krona", "Morningstar Sector": "Industrials", "Morningstar Category": None}]}))
else:
    print(json.dumps({"ok": False, "error": "okänt"}))
