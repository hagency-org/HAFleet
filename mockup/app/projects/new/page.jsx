'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { send } from '@/lib/api';

/*
 * Adding a project side, as a form rather than a shell recipe.
 *
 * WHY THIS PAGE EXISTS, in the operator's words: 「你让用户跑 script？为何不做成 ui，可以选择系统内可达的
 * matrix server，可以在 ui 注册代表」. They were right. The procedure was being handed over as four curl
 * commands and a guessed callback URL — for a procedure whose own documentation
 * (`docs/FOR-PROJECT-SIDES.md`) exists BECAUSE it is full of traps. Traps are what a form absorbs; the
 * document should explain what happened, not be the tool.
 *
 * WHAT IT ABSORBS, each one a trap that has cost real time:
 *
 *   THE HOMESERVER IS OFFERED, NOT TYPED. `GET /api/matrix/reach` probes each candidate, so "is it
 *   reachable" is answered before anything is issued rather than inferred later from silence.
 *
 *   THE CALLBACK URL IS A CHOICE WITH REASONS. `127.0.0.1` is right when the homeserver is a process on
 *   the HAFleet host and is the most common wrong answer when it is a container — where the appservice
 *   looks installed and receives nothing. The list says which is which rather than leaving it to be
 *   discovered from silence.
 *
 *   THE APPSERVICE SOCKET IS CHECKED FIRST. With no `HAFLEET_APPSERVICE_PORT` the bridge opens no socket,
 *   so a perfect registration installed at a perfect address still hears nothing. Said before step one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never displays a token. The registration is written to a 0600 file
 * on the HAFleet host and this page is told a path and two fingerprints. The endpoint that returns the
 * YAML is not proxied to the browser at all, and that refusal is marked in the proxy as a decision rather
 * than an omission — an `as_token` authorises a whole namespace on someone else's homeserver, and a
 * browser is memory, devtools, history, and whatever extension is watching.
 *
 * STYLED WITH THE VOCABULARY THAT WAS ALREADY HERE. A first version brought its own `<style jsx>` block;
 * no other page in this console has one, and `.steps`, `.pill`, `.card`, `.kv`, `.field` and `.notice`
 * already existed. A parallel set of styles would have made this page the odd one out in a console whose
 * whole value is looking like a single thing.
 */

const STEPS = ['选服务器', '建立客户方', '生成代表凭据', '安装并验证'];

export default function NewProjectSide() {
  const [toast, say] = useToast();
  const [reach, setReach] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [step, setStep] = useState(0);

  const [server, setServer] = useState('');
  const [label, setLabel] = useState('');
  /*
   * MANUALLY ADDED SERVERS, because discovery alone is circular. The candidate list is what this
   * deployment already knows about — its own homeserver and sides already recorded — and a NEW customer
   * is in neither. A form built only on that list can never add the first one, which is what the operator
   * hit: 「为何不能加 chinasoft 客户端」. Probed before it can be selected, so "typed by hand" does not
   * mean "unchecked".
   */
  const [manual, setManual] = useState([]);
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [callback, setCallback] = useState('');
  /*
   * WHICH CREDENTIAL, and this choice was missing — which made the whole flow wrong for the commonest
   * deployment. The operator said it plainly: 「我的 agent 都在内网，而且接入 matrix 服务器本身不需要公网
   * 地址，你这个设计是错的」.
   *
   * They are right. An APPSERVICE is inbound: the homeserver PUSHES transactions to HAFleet, so HAFleet
   * must be reachable from it — which for an internal network means exposing it. A REGISTRATION TOKEN is
   * outbound only: HAFleet registers accounts and talks to the homeserver over the client-server API with
   * `/sync`, exactly as a phone does, and needs no inbound reachability at all.
   *
   * So the outbound one is the default. The previous version offered only the appservice path and then
   * asked which address the homeserver could reach us at — a question that only exists because of a
   * choice the operator was never shown.
   */
  const [credKind, setCredKind] = useState('registrationToken');
  const [regToken, setRegToken] = useState('');
  const [cbCheck, setCbCheck] = useState(null);
  const [issued, setIssued] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [busy, setBusy] = useState(false);

  /*
   * PROBED ON EVERY VISIT, not cached. An operator opens this page because something is being set up or
   * has broken, and a remembered "reachable" is the one answer that would mislead them — it sends them to
   * debug a registration when the homeserver is simply down.
   */
  useEffect(() => {
    let live = true;
    (async () => {
      const res = await send('matrix/reach', { method: 'GET' });
      if (!live) return;
      if (res.ok === false) setLoadErr(res.error ?? '无法读取可达性');
      else setReach(res.body);
    })();
    return () => { live = false; };
  }, []);

  const servers = [...(reach?.homeservers ?? []), ...manual];
  const appservice = reach?.appservice ?? null;
  const chosen = servers.find((s) => s.serverName === server) ?? null;

  async function probeManual() {
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name) return say('fail', '填一个服务器名');
    if (servers.some((s) => s.serverName === name)) return say('fail', `${name} 已经在列表里了`);
    setProbing(true);
    // The name alone is enough — the backend does the well-known lookup the protocol specifies. A URL is
    // sent only when the operator typed one, as an override for deployments with no well-known.
    const res = await send('matrix/probe', { method: 'POST', body: { server_name: name, url: url || undefined } });
    setProbing(false);
    if (res.ok === false) return say('fail', `探测失败：${res.error}`);
    const { origin, probe, via } = res.body ?? {};
    /*
     * ADDED WHETHER OR NOT IT ANSWERED. An unreachable entry stays on screen with its reason so the
     * operator can see what they typed and why it failed — removing it would make a typo look like the
     * form ignoring them, and "cannot reach it right now" is not the same as "you should not add it".
     * Selection is still gated on the probe, so it cannot be carried forward while unreachable.
     */
    setManual((prev) => [...prev, {
      serverName: name,
      url: origin ?? url,
      source: via ?? '你刚才填的',
      alreadyASide: false,
      probe,
    }]);
    if (probe?.reachable) {
      setServer(name);
      say('ok', `${name} 可达`);
    } else {
      say('fail', `${name} 不可达：${probe?.reason ?? '未知原因'}`);
    }
    return setDraftName('');
  }

  async function createSide() {
    setBusy(true);
    /*
     * `api_base_url` IS REQUIRED and its absence is what made this step fail with
     * "api_base_url must be 1..1024 characters". It is not a detail the form can omit: a server NAME is
     * an identity (`example.org`) and the base URL is where that identity is served
     * (`https://matrix.example.org`), and Matrix routinely puts them on different hosts. Only the
     * project side knows both, so both are carried from the候选 the operator picked.
     */
    const res = await send('project-sides', {
      method: 'POST',
      body: { server_name: server, api_base_url: chosen?.url, label: label || undefined },
    });
    setBusy(false);
    if (res.ok === false) return say('fail', `建立失败：${res.error}`);
    say('ok', `已建立客户方 ${server}`);
    setStep(2);
    /*
     * ASKED, NOT GUESSED, whenever the homeserver is a container this host can see. The alternative is
     * making the operator certain about container networking — the one thing the failure mode hides.
     */
    const check = await send('matrix/callback-check', {
      method: 'POST',
      body: { homeserver_url: chosen?.url },
    });
    if (check.ok !== false) {
      setCbCheck(check.body);
      if (check.body?.recommended) setCallback(check.body.recommended);
    }
    /*
     * PRE-SELECTED FROM THE EDGE even when the container check cannot run — a homeserver that is not a local
     * container is unverifiable from here, and leaving the field blank would block the flow on a question
     * whose answer the operator already gave when they configured the edge.
     */
    if (!callback && reach?.appservice?.inboundVia === 'edge' && reach.appservice.edgeUrl) {
      setCallback(reach.appservice.edgeUrl);
    }
    return undefined;
  }

  async function issueRegistration() {
    setBusy(true);
    /*
     * `?replace=true` only when there IS something to replace. The backend refuses a second issue with a
     * 409 by design — replacing invalidates a registration the homeserver may already have installed and
     * stops delivery until the new one is in place — so the flag is sent deliberately, never by default.
     */
    const replacing = chosen?.hasCredential ? '?replace=true' : '';
    const res = await send(`project-sides/${encodeURIComponent(server)}/registration-file${replacing}`, {
      method: 'POST',
      body: { url: callback },
    });
    setBusy(false);
    if (res.ok === false) return say('fail', `生成失败：${res.error}`);
    setIssued(res.body);
    return setStep(3);
  }

  async function saveRegistrationToken() {
    if (!regToken.trim()) return say('fail', '把客户方给你的注册令牌填进来');
    setBusy(true);
    const res = await send(`project-sides/${encodeURIComponent(server)}/credential`, {
      method: 'PUT',
      body: { credential: { kind: 'registrationToken', registrationToken: regToken.trim() } },
    });
    setBusy(false);
    if (res.ok === false) return say('fail', `保存失败：${res.error}`);
    /*
     * The token is dropped from this component the moment it is accepted. It is write-only at the API too
     * — no endpoint hands a credential back — and keeping a copy in a live React state for the rest of
     * the session would be the one place it lingered.
     */
    setRegToken('');
    setIssued({
      registrationToken: true,
      representative: `@hafleet:${server}`,
      nextSteps: [
        'Nothing to install on the homeserver, and nothing to restart: HAFleet registers the '
        + 'representative and one account per agent over the client-server API.',
        'No inbound reachability is needed. HAFleet talks OUT to your homeserver, so this works with '
        + 'HAFleet behind NAT or on an internal network.',
        'The representative arrives in your rooms with users_default power. A default Matrix room needs '
        + 'power 50 to invite, so grant it that or invite each agent yourself.',
      ],
    });
    say('ok', '凭据已保存');
    return setStep(3);
  }

  async function verify() {
    setBusy(true);
    const res = await send(`project-sides/${encodeURIComponent(server)}/verify`, { method: 'POST' });
    setBusy(false);
    if (res.ok === false) return say('fail', `验证失败：${res.error}`);
    return setVerdict(res.body);
  }

  return (
    <main className="main">
      <PageHead title="接入一个客户方" sub="选择系统能到达的 Matrix 服务器，生成接单员凭据" />

      <div className="btn-row">
        {STEPS.map((s, i) => (
          <span key={s} className={i === step ? 'stg' : 'pill'}>{i + 1}. {s}</span>
        ))}
      </div>

      {loadErr && <div className="notice"><span className="warn-text">读取可达性失败：{loadErr}</span></div>}

      {/*
        * SAID BEFORE STEP ONE, because it is the fact an operator would otherwise learn last: without a
        * socket everything below succeeds and nothing ever arrives.
        */}
      {/*
        * THREE STATES, not two, and conflating them made this screen wrong on the deployment the feature was
        * built for. A co-located edge means events arrive with NO socket here — reporting that as "nothing is
        * listening" told the operator to open an inbound port, which is exactly what co-locating avoids, on
        * a host with a public address.
        */}
      {appservice?.inboundVia === 'edge' && (
        <div className="notice">
          <span className="pill ok-text">入站走 co-located edge</span>{' '}
          <span className="dim">{appservice.reason}</span>
        </div>
      )}
      {appservice && !appservice.listening && appservice.inboundVia !== 'edge' && (
        <div className="notice">
          <strong className="warn-text">没有任何东西会接收入站事务。</strong>
          <p className="dim">{appservice.reason}</p>
          <p className="dim">
            现在生成的注册文件本身是对的，但你的 homeserver 推送过来的事务不会有人接。
            要么开一个入站端口，要么在 homeserver 旁边跑 <span className="mono-s">bin/hafleet-appservice-edge</span>。
          </p>
        </div>
      )}

      {step === 0 && (
        <section className="card">
          <h3 className="sub">1. 选一个 Matrix 服务器</h3>
          {!reach && !loadErr && <p className="dim">正在探测…</p>}
          {reach && servers.length === 0 && (
            <p className="empty">
              没有候选。候选只来自本部署的配置和已登记的客户方——这里不做网络扫描，因为替客户扫描他们的网络
              并不等于他们同意了什么。
            </p>
          )}
          <ul className="steps">
            {servers.map((s) => {
              /*
               * A SIDE THAT EXISTS IS NOT A SIDE THAT IS FINISHED, and treating them the same created a
               * dead end the operator hit: they created `palpo2.test`, did not reach the credential step,
               * came back, and found it greyed out as "already a side" — unable to finish it or restart.
               * Only a working credential is a reason to stop; everything else still needs this flow.
               */
              const usable = Boolean(s.probe?.reachable);
              return (
                <li key={s.serverName ?? s.url}>
                  <input
                    type="radio"
                    name="hs"
                    checked={server === s.serverName}
                    onChange={() => setServer(s.serverName)}
                    disabled={!usable}
                  />
                  <div>
                    <span className="mono-s">{s.serverName ?? '(没有服务器名)'}</span>{' '}
                    <span className={s.probe?.reachable ? 'pill ok-text' : 'pill warn-text'}>
                      {s.probe?.reachable ? `可达 · ${(s.probe.versions ?? []).join(' ')}` : '不可达'}
                    </span>
                    {s.alreadyASide && !s.hasCredential && (
                      <span className="pill warn-text"> 已建立但没有凭据，可以接着做</span>
                    )}
                    {s.alreadyASide && s.hasCredential && (
                      <span className="pill dim"> 已完成（再来一次会换掉现有凭据）</span>
                    )}
                    <div className="why-inline">
                      {s.url ?? '没有可探测的地址'} — {s.source}
                      {!s.probe?.reachable && s.probe?.reason ? `；${s.probe.reason}` : ''}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {/*
            * THE WAY IN FOR A SERVER NOBODY HAS RECORDED YET, which is every customer on their first day.
            * Discovery is a convenience here, not the gate.
            */}
          <h3 className="sub">或者，填一个还没登记过的</h3>
          <div className="field-row">
            <label htmlFor="draft-name">服务器名</label>
            <input
              id="draft-name"
              className="inp"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="chinasoft.example"
            />
          </div>
          <p className="why-inline">
            地址会自己查出来：Matrix 规定了怎么把服务器名解析成地址
            （<span className="mono-s">/.well-known/matrix/client</span>），每个 Matrix 客户端登录时做的就是这件事。
            所以 <span className="mono-s">chinasoft.example</span> 的 homeserver 就算实际住在
            <span className="mono-s"> matrix.chinasoft.example</span>，你也不用知道。
          </p>
          <div className="field-row">
            <label htmlFor="draft-url">地址（可留空）</label>
            <input
              id="draft-url"
              className="inp"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="留空 = 自动发现"
            />
          </div>
          <p className="why-inline">
            只有在对方没有配 well-known 时才需要填——私有部署、或者带端口的名字，常常是这种情况。
            填了就以你填的为准，不会被发现结果悄悄替换掉。
          </p>
          <div className="btn-row">
            <button type="button" className="btn" disabled={probing} onClick={probeManual}>
              {probing ? '探测中…' : '探测并加入'}
            </button>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={!server}
              onClick={async () => {
                /*
                 * SKIP THE CREATE STEP for a side that already exists — posting it again would 409, and
                 * showing a form whose only outcome is an error is worse than not showing it.
                 */
                if (!chosen?.alreadyASide) return setStep(1);
                setStep(2);
                const check = await send('matrix/callback-check', {
                  method: 'POST',
                  body: { homeserver_url: chosen?.url },
                });
                if (check.ok !== false) {
                  setCbCheck(check.body);
                  if (check.body?.recommended) setCallback(check.body.recommended);
                }
                return undefined;
              }}
            >
              {chosen?.alreadyASide ? '接着做（已建立，直接去生成凭据）' : '下一步'}
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card">
          <h3 className="sub">2. 建立客户方</h3>
          <p className="dim">服务器名 <span className="mono-s">{server}</span>。名称只给你自己看，可以留空。</p>
          <div className="field">
            <label htmlFor="side-label">名称</label>
            <input
              id="side-label"
              className="inp"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：Acme 的运维房间"
            />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setStep(0)}>返回</button>
            <button type="button" className="btn" disabled={busy} onClick={createSide}>
              {busy ? '建立中…' : '建立'}
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card">
          <h3 className="sub">3. 接单员凭据</h3>
          {/*
            * THE CHOICE THAT WAS MISSING, and stated in the terms that decide it: which direction the
            * connection goes. Everything else about these two options is secondary to that.
            */}
          <ul className="steps">
            <li>
              <input
                type="radio"
                name="ck"
                checked={credKind === 'registrationToken'}
                onChange={() => setCredKind('registrationToken')}
              />
              <div>
                <strong>注册令牌</strong> <span className="pill ok-text">不需要公网地址</span>
                <div className="why-inline">
                  纯出站：HAFleet 主动连你的 homeserver，用客户端 API 和 <span className="mono-s">/sync</span>，
                  和手机上的 Matrix 客户端一样。HAFleet 在内网、NAT 后面都能用。
                </div>
                <div className="why-inline">
                  代价：HAFleet 会为接单员和每个 agent 各注册一个账号——账号更多，但不用你装任何东西、不用重启。
                </div>
              </div>
            </li>
            <li>
              <input
                type="radio"
                name="ck"
                checked={credKind === 'appservice'}
                onChange={() => setCredKind('appservice')}
              />
              <div>
                <strong>Appservice</strong> <span className="pill warn-text">需要你的 homeserver 能反向找到 HAFleet</span>
                <div className="why-inline">
                  入站：homeserver 把事件<strong>推</strong>给 HAFleet，所以 HAFleet 必须从它那一侧可达。
                  两边在同一台机器或同一内网时合适；HAFleet 在内网而 homeserver 在外面时，这条要求你把 HAFleet 暴露出去。
                </div>
                <div className="why-inline">
                  好处：一份凭据覆盖 <span className="mono-s">@ac_*</span> 整个命名空间，agent 无需逐个注册账号。
                </div>
              </div>
            </li>
          </ul>

          {credKind === 'registrationToken' && (
            <>
              <p className="dim">
                把客户方给你的注册令牌填进来。接单员 <span className="mono-s">@hafleet:{server}</span> 会用它注册，
                之后每个 agent 也用它领自己的账号。
              </p>
              <div className="field-row">
                <label htmlFor="reg-token">注册令牌</label>
                <input
                  id="reg-token"
                  className="inp"
                  type="password"
                  value={regToken}
                  onChange={(e) => setRegToken(e.target.value)}
                  placeholder="客户方 homeserver 的 registration token"
                />
              </div>
              <p className="why-inline">
                只写不读：保存之后没有任何接口能把它取回来，这个页面也会立刻丢掉它。
              </p>
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => setStep(1)}>返回</button>
                <button type="button" className="btn" disabled={busy} onClick={saveRegistrationToken}>
                  {busy ? '保存中…' : '保存凭据'}
                </button>
              </div>
            </>
          )}

          {credKind === 'appservice' && (
            <>
          <p className="dim">
            接单员不用你手工注册账号——它就是 appservice 的 <span className="mono-s">sender_localpart</span>，
            装上注册文件后 <span className="mono-s">@hafleet:{server}</span> 自动成为代表，
            <span className="mono-s"> @ac_*</span> 命名空间让所有 agent 无需注册即可寻址。
          </p>
          {/*
            * WITH AN EDGE THE QUESTION IS ALREADY ANSWERED, so asking it again invites the operator to change
            * a working answer. They configured the edge; the registration points at it. The candidate list
            * exists only because nobody knows which of THIS host's addresses a homeserver can reach.
            */}
          {appservice?.inboundVia === 'edge' ? (
            <p>
              <strong>注册文件要指向你那个 co-located edge</strong>
              <span className="mono-s"> {appservice.edgeUrl}</span>
              ——你已经配好了，不用再选地址。
            </p>
          ) : (
            <p><strong>你的 homeserver 从它自己那一侧，用哪个地址能找到 HAFleet？</strong></p>
          )}
          {/*
            * The one question this flow cannot answer for the operator, stated as such. Matrix has no
            * "call me back" endpoint, so nothing here can prove an address before installation — and a
            * tool that presented a guess as a verdict would be worse than the shell recipe, because the
            * operator would stop looking.
            */}
          <ul className="steps">
            {(appservice?.callbackCandidates ?? []).map((c) => (
              <li key={c.url}>
                <input type="radio" name="cb" checked={callback === c.url} onChange={() => setCallback(c.url)} />
                <div>
                  <span className="mono-s">{c.url}</span>
                  {cbCheck?.results?.find((r) => r.url === c.url)?.reachableFromHomeserver && (
                    <span className="pill ok-text"> homeserver 里实测可达</span>
                  )}
                  {cbCheck?.applicable
                    && cbCheck.results?.find((r) => r.url === c.url)?.reachableFromHomeserver === false && (
                    <span className="pill warn-text"> 里面打不通</span>
                  )}
                  <div className="why-inline">{c.why}</div>
                  <div className="why-inline">{c.confidence}</div>
                </div>
              </li>
            ))}
          </ul>
          {cbCheck?.applicable && (
            <div className="notice">
              <span className={cbCheck.recommended ? 'pill ok-text' : 'pill warn-text'}>
                {cbCheck.recommended ? '已从你的 homeserver 里面验证' : '容器里一个都打不通'}
              </span>{' '}
              {cbCheck.reason}
              <p className="why-inline">{cbCheck.checkedFrom}</p>
            </div>
          )}
          {cbCheck && !cbCheck.applicable && (
            <p className="dim">无法从 homeserver 那一侧验证：{cbCheck.reason}</p>
          )}
          {/* Only claim nothing is verified when nothing was. */}
          {!cbCheck?.recommended && appservice?.proof && <p className="dim">{appservice.proof}</p>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setStep(1)}>返回</button>
            <button type="button" className="btn" disabled={!callback || busy} onClick={issueRegistration}>
              {busy ? '生成中…' : '生成'}
            </button>
          </div>
            </>
          )}
        </section>
      )}

      {step === 3 && issued && (
        <section className="card">
          <h3 className="sub">4. 安装并验证</h3>
          {/*
            * A PATH AND FINGERPRINTS, never the tokens. This page is never told them, so it cannot show
            * them, and no later "just display it once" can leak them from here.
            */}
          {/*
            * TWO SHAPES, because the two credential kinds produce different artefacts. The token path
            * writes no file and has nothing to install, and rendering the appservice fields for it showed
            * "权限 undefined" — a form claiming to have done something it had not.
            */}
          {issued.registrationToken ? (
            <>
              <p className="dim">凭据已保存。没有文件要装，homeserver 也不用重启。</p>
              <dl className="kv">
                <dt>接单员</dt><dd className="mono-s">{issued.representative}</dd>
                <dt>方式</dt><dd>注册令牌（纯出站）</dd>
              </dl>
            </>
          ) : (
            <>
              <p className="dim">注册文件已写到 HAFleet 主机上，权限 {issued.mode}：</p>
              <p className="mono-s">{issued.path}</p>
              <dl className="kv">
                <dt>接单员</dt><dd className="mono-s">{issued.representative}</dd>
                <dt>命名空间</dt><dd className="mono-s">{issued.namespace}</dd>
                <dt>回拨地址</dt><dd className="mono-s">{issued.url}</dd>
                <dt>as_token 指纹</dt><dd className="mono-s">{issued.asTokenFingerprint}</dd>
                <dt>hs_token 指纹</dt><dd className="mono-s">{issued.hsTokenFingerprint}</dd>
              </dl>
              <p className="dim">
                指纹是四个字节，只够确认「你装的就是这一份」，不足以用来认证。令牌本身不经过浏览器。
              </p>
            </>
          )}
          <ul className="steps">
            {(issued.nextSteps ?? []).map((s, i) => (
              <li key={s}><span className="stg">{i + 1}</span><div>{s}</div></li>
            ))}
          </ul>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={verify}>
              {busy ? '验证中…' : '验证凭据'}
            </button>
            <Link className="btn" href="/projects">回到项目页</Link>
          </div>
          {verdict && (
            <div className="notice">
              <span className={verdict.accessState === 'accepted' ? 'pill ok-text' : 'pill warn-text'}>
                {verdict.accessState ?? '未知'}
              </span>{' '}
              {verdict.detail ?? verdict.reason ?? ''}
              <p className="dim">
                「凭据被拒」和「服务器不可达」是两个不同的答案——只有 401/403 才是对令牌的判决。
              </p>
            </div>
          )}
        </section>
      )}

      <Toast toast={toast} />
    </main>
  );
}
