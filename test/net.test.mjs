// Offline tests for the outbound-network helpers: apiCall + fetchUrl. Every case here short-circuits
// BEFORE any real network I/O — invalid input, bad protocol, or the SSRF guard rejecting a
// private/internal host (dns.lookup on an IP literal resolves locally, no DNS query). No server, no
// live hosts.  run:  node test/net.test.mjs
import { apiCall, fetchUrl } from "../server.mjs";

let pass = 0, fail = 0;
const chk = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); cond ? pass++ : fail++; };

console.log("# fetchUrl — validation + SSRF guard (no live fetches)");
chk("  garbage → not a valid URL", (await fetchUrl("garbage")).error === "not a valid URL");
chk("  ftp:// → only http(s) allowed", /only http/.test((await fetchUrl("ftp://example.com/x")).error));
for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://192.168.1.1/", "http://0.0.0.0/"]) {
  const r = await fetchUrl(u);
  chk(`  SSRF-refuses ${u}`, r.ok === false && /refused|private|internal/i.test(r.error || ""));
}

console.log("# fetchUrl — DNS failure on an unresolvable host (RFC-2606 .invalid)");
{ const r = await fetchUrl("http://nonexistent-host-zzz.invalid/x"); chk("  unresolvable host → DNS error, not a crash", r.ok === false && /DNS|resolution|records/i.test(r.error || "")); }

console.log("# apiCall — input parsing + SSRF guard");
chk("  empty → guidance error", /provide a JSON/.test((await apiCall("")).error));
chk("  prose without URL → guidance error", /provide a JSON/.test((await apiCall("please call the weather service")).error));
chk("  ftp URL → guidance error (only http(s) recognized)", /provide a JSON/.test((await apiCall("ftp://example.com")).error));
chk("  plain private URL → SSRF refused", /refused|private|internal/i.test((await apiCall("http://127.0.0.1/x")).error || ""));
chk("  JSON {url,method} to metadata IP → SSRF refused", /refused|private|internal/i.test((await apiCall('{"url":"http://169.254.169.254/","method":"delete"}')).error || ""));
chk("  JSON without a url → guidance error", /provide a JSON/.test((await apiCall('{"method":"POST","body":"x"}')).error));

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
