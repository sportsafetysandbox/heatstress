// HEAT/SG — WBGT + Crowd proxy worker
// Routes:
//   ?api=wbgt        → NEA WBGT (with pagination)
//   ?api=lightning   → NEA Lightning (with pagination)
//   ?api=psi         → NEA PSI (with pagination)
//   ?api=pm25        → NEA 1-hr PM2.5 (with pagination)
//   ?api=crowd       → ActiveSG facility capacities
//
// Secrets required (Settings → Variables and Secrets):
//   DATAGOV_API_KEY  — data.gov.sg API key
//   CF_CLEARANCE     — cf_clearance cookie from activesg.gov.sg

const NEA_WEATHER_BASE = "https://api-open.data.gov.sg/v2/real-time/api/weather";
const NEA_PSI_BASE     = "https://api-open.data.gov.sg/v2/real-time/api/psi";
const NEA_PM25_BASE    = "https://api-open.data.gov.sg/v2/real-time/api/pm25";
const ACTIVESG_CROWD   = "https://activesg.gov.sg/api/trpc/pass.getFacilityCapacities?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D";

const ALLOWED_ORIGIN = "*";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const incomingUrl = new URL(request.url);
      const params = incomingUrl.searchParams;
      const apiName = params.get("api") || "wbgt";

      // ---- Crowd route — uses cf_clearance cookie to bypass bot check ----
      if (apiName === "crowd") {
        const upstream = await fetch(ACTIVESG_CROWD, {
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Referer": "https://activesg.gov.sg/gym-pool-crowd",
            "Origin": "https://activesg.gov.sg",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            // The cf_clearance cookie lets Cloudflare know this is a
            // verified browser session — stored as a Worker secret
            "Cookie": `cf_clearance=${env.CF_CLEARANCE}`
          }
        });

        if (!upstream.ok) {
          return new Response(JSON.stringify({
            error: true,
            status: upstream.status,
            message: `ActiveSG returned ${upstream.status}`
          }), {
            status: upstream.status,
            headers: { "Content-Type": "application/json", ...corsHeaders() }
          });
        }

        const json = await upstream.json();
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      // ---- NEA routes (wbgt, lightning, psi, pm25) ----
      const isPSI  = apiName === "psi";
      const isPM25 = apiName === "pm25";
      // Both PSI and PM25 use the "items" array shape; weather APIs use "records"
      const isItemsShape = isPSI || isPM25;

      let upstreamBase;
      if (isPSI)       upstreamBase = NEA_PSI_BASE;
      else if (isPM25) upstreamBase = NEA_PM25_BASE;
      else             upstreamBase = NEA_WEATHER_BASE;

      // Strip the "api" param before forwarding (PSI/PM25 endpoints don't take it)
      if (isItemsShape) params.delete("api");

      const allRecords = [];
      const allItems   = [];
      let regionMetadata  = null;
      let paginationToken = null;
      let pageCount = 0;
      const MAX_PAGES = 10;

      do {
        const upstreamUrl = new URL(upstreamBase);
        params.forEach((value, key) => upstreamUrl.searchParams.set(key, value));
        if (paginationToken) upstreamUrl.searchParams.set("paginationToken", paginationToken);

        const upstream = await fetch(upstreamUrl.toString(), {
          headers: { "x-api-key": env.DATAGOV_API_KEY, "Accept": "application/json" }
        });

        if (!upstream.ok) {
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: { "Content-Type": "application/json", ...corsHeaders() }
          });
        }

        const json = await upstream.json();
        if (isItemsShape) {
          allItems.push(...((json.data && json.data.items) || []));
          if (!regionMetadata) regionMetadata = (json.data && json.data.regionMetadata) || null;
        } else {
          allRecords.push(...((json.data && json.data.records) || []));
        }
        paginationToken = (json.data && json.data.paginationToken) || null;
        pageCount++;
      } while (paginationToken && pageCount < MAX_PAGES);

      const merged = isItemsShape
        ? { code: 0, errorMsg: "", data: { regionMetadata: regionMetadata || [], items: allItems } }
        : { code: 0, errorMsg: "", data: { records: allRecords } };

      return new Response(JSON.stringify(merged), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy failed", detail: String(err) }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders() } }
      );
    }
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
