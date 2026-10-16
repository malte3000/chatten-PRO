import React, { useEffect, useMemo, useState } from "react";
import { createPaperCloudClient, paperAuthRedirectError } from "./paperCloudClient.js";
import { syncPaperCloud } from "./paperCloudSync.js";

const CONTROL = "border border-cyan-800 bg-slate-950 text-slate-100 rounded px-3 py-2 text-sm";

export default function PaperCloudPanel({ localCount, onSynced }) {
  const client = useMemo(() => createPaperCloudClient(), []);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(client.enabled);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("signin");
  const [error, setError] = useState(() => paperAuthRedirectError());
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!client.enabled) return undefined;
    let active = true;
    async function refreshUser() {
      try {
        const { data } = await client.getUser();
        if (active) setUser(data?.user || null);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setChecking(false);
      }
    }
    refreshUser();
    const { data } = client.onAuthStateChange(() => {
      // Supabase auth callbacks should not await another Supabase request.
      window.setTimeout(refreshUser, 0);
    });
    return () => { active = false; data?.subscription?.unsubscribe(); };
  }, [client]);

  if (!client.enabled) return null;

  async function authenticate(event) {
    event.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      const result = mode === "signup" ? await client.signUp(email.trim(), password) : await client.signIn(email.trim(), password);
      if (result.error) throw result.error;
      setPassword("");
      if (mode === "signup" && !result.data?.session) {
        setNotice("Kontot är skapat. Bekräfta e-postadressen via länken från Supabase och logga sedan in här. Om länken inte fungerar kan du begära en ny nedan.");
      } else {
        const verified = await client.getUser();
        if (verified.error || !verified.data?.user) throw new Error("Kontot kunde inte verifieras. Försök logga in igen.");
        setUser(verified.data.user);
        setNotice("Du är inloggad i din personliga paperlogg. Tryck Synka när du vill föra över observationer.");
      }
    } catch (problem) {
      setError(`Kontot kunde inte användas: ${problem.message}`);
    } finally { setBusy(false); }
  }

  async function resendConfirmation() {
    const address = email.trim();
    if (!address) { setError("Ange e-postadressen för kontot först."); return; }
    setError(""); setNotice(""); setBusy(true);
    try {
      const result = await client.resendSignupConfirmation(address);
      if (result.error) throw result.error;
      setNotice("Om kontot väntar på bekräftelse har en ny länk begärts. Kontrollera inkorg och skräppost och använd det senaste mejlet.");
    } catch (problem) {
      if (problem.code === "over_email_send_rate_limit" || problem.status === 429) {
        setError("För många bekräftelsemejl har begärts. Vänta en stund innan du försöker igen.");
      } else {
        setError(`Ny bekräftelselänk kunde inte begäras: ${problem.message}`);
      }
    } finally { setBusy(false); }
  }

  async function signOut() {
    setError(""); setNotice(""); setBusy(true);
    try {
      const result = await client.signOut();
      if (result.error) throw result.error;
      setUser(null);
      setNotice("Du är utloggad från den personliga paperloggen. Lokala observationer finns kvar i den här webbläsaren.");
    } catch (problem) { setError(`Utloggningen misslyckades: ${problem.message}`); }
    finally { setBusy(false); }
  }

  async function sync() {
    setError(""); setNotice(""); setBusy(true);
    try {
      const verified = await client.getUser();
      if (verified.error || verified.data?.user?.id !== user?.id) throw new Error("Sessionen kunde inte verifieras. Logga in igen.");
      const result = await syncPaperCloud({ client, userId: user.id, storage: window.localStorage, lockManager: navigator.locks });
      onSynced(result.records);
      if (result.records.length === 0) {
        setNotice("Synken är klar, men paperloggen är tom både i den här webbläsaren och i molnet. Inget fördes över.");
      } else if (result.uploaded === 0 && result.downloaded === 0 && result.advanced === 0) {
        setNotice("Synken är klar. Inga nya eller ändrade paperobservationer fördes över den här gången.");
      } else {
        setNotice(`Synk klar: ${result.uploaded} lokala observationer uppladdade, ${result.downloaded} hämtade och ${result.advanced} senare paperutfall uppdaterade i molnet. Ta gärna en JSON-kopia som extra backup.`);
      }
    } catch (problem) {
      setError(`Synken avbröts: ${problem.message} Ingen konflikt skrevs över. Om ett uppladdat utfall avbröts mitt i processen kan du prova Synka igen.`);
    } finally { setBusy(false); }
  }

  return <div className="border-t border-slate-800 pt-3 space-y-3 text-sm">
    <h3 className="font-medium">Personlig molnsynk · test</h3>
    <p className="text-xs text-slate-400">Ett separat Supabase-konto används för paperloggen. Dagens gemensamma terminalinloggning och journal ändras inte. Synk sker bara när du trycker på knappen.</p>
    <p className="text-xs text-amber-300">Lokala poster som laddas upp märks som importerade och är inte verifierade affärer eller bevis för strategins träffsäkerhet. En konflikt mellan låsta signaler eller slututfall stoppar synken.</p>
    {localCount !== null && <p className="text-xs text-slate-300">I den här webbläsaren: {localCount} paperobservationer.</p>}
    {checking ? <p className="text-slate-400">Kontrollerar konto…</p> : user ? <div className="flex flex-wrap gap-3 items-center">
      <span className="text-slate-300">Inloggad: {user.email || "personligt konto"}</span>
      <button type="button" className={CONTROL} onClick={sync} disabled={busy}>Synka paperloggen nu</button>
      <button type="button" className={CONTROL} onClick={signOut} disabled={busy}>Logga ut</button>
    </div> : <form className="flex flex-wrap gap-3 items-end" onSubmit={authenticate}>
      <label>E-post<input className={`${CONTROL} block mt-1`} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Lösenord<input className={`${CONTROL} block mt-1`} type="password" minLength="6" autoComplete={mode === "signup" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className={CONTROL} type="submit" disabled={busy}>{mode === "signup" ? "Skapa konto" : "Logga in"}</button>
      <button className={CONTROL} type="button" disabled={busy} onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); setPassword(""); }}>{mode === "signup" ? "Har du redan konto?" : "Skapa nytt konto"}</button>
      <button className={CONTROL} type="button" disabled={busy || !email.trim()} onClick={resendConfirmation}>Skicka ny bekräftelselänk</button>
    </form>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {notice && <p role="status" className="text-cyan-300">{notice}</p>}
  </div>;
}
