/**
 * dsh-weibo-dive —— 客户端半边：DSH「设置」里的「微博」section
 *
 * 数据流：section ⇄ /dsh-weibo-dive/api/* ⇄ ~/.dsh/weibo-dive/{config.json,persona.md}
 * cookie 只显示「是否登录」和打码后的样子，永不回显原文。
 */
window.__ModuleLoader__.load({
  id: "dsh-weibo-dive",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-weibo-dive/api";
    const CSS_TAG = "dsh-weibo-dive/section.css";
    const CSS = [
      ".wbd{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".wbd-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".wbd-cards{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 2px}",
      ".wbd-card{flex:1 1 150px;min-width:140px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 12px}",
      ".wbd-card-k{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".wbd-card-v{font-size:14px;line-height:22px;margin-top:2px;font-variant-numeric:tabular-nums}",
      ".wbd-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}",
      ".wbd-bad{color:var(--dsw-alias-state-error-primary)}",
      ".wbd-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}",
      ".wbd-rows{display:flex;flex-direction:column}",
      ".wbd-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".wbd-row:last-child{border-bottom:none}",
      ".wbd-row>div:first-child{flex:1;min-width:190px}",
      ".wbd-label{font-size:13px;line-height:19px}",
      ".wbd-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".wbd-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".wbd-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:96px;outline:none;font-variant-numeric:tabular-nums}",
      ".wbd-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".wbd-input.wbd-wide{min-width:220px}",
      ".wbd-input.wbd-time{min-width:108px}",
      ".wbd-textarea{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:19px;padding:8px 10px;width:100%;min-height:180px;outline:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}",
      ".wbd-textarea.wbd-short{min-height:64px;font-family:inherit;font-size:12.5px}",
      ".wbd-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".wbd-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".wbd-btn:disabled{opacity:.45;cursor:default}",
      ".wbd-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".wbd-btn3{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);height:26px;padding:0 9px;font-size:12px}",
      ".wbd-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:320px;overflow:auto;margin-top:10px}",
      ".wbd-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px}",
      ".wbd-dirty{color:#e8a33d;font-size:12.5px;margin-left:2px}",
      ".wbd-win{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".wbd-sep{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".wbd-cats{display:flex;flex-wrap:wrap;gap:7px 16px;max-width:440px}",
      ".wbd-cat{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}",
      ".wbd-cat input{margin:0}",
      ".wbd-cat.wbd-mute{color:var(--dsw-alias-label-tertiary)}",
      ".wbd-note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
    ].join("\n");

    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

    async function call(pathname, init) {
      const r = await fetch(API + pathname, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      let body = null;
      try { body = await r.json(); } catch { body = { ok: false, error: `HTTP ${r.status}` } }
      if (!r.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${r.status}`);
      return body;
    }

    // 自检的 ok:false 是「检查结果」，不是接口错误，不能按 call() 的规矩抛掉。
    async function callSoft(pathname, init) {
      const r = await fetch(API + pathname, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      let body = null;
      try { body = await r.json(); } catch { body = { ok: false, error: `HTTP ${r.status}` } }
      if (!r.ok && !body?.items) throw new Error(body?.error || `HTTP ${r.status}`);
      return body;
    }

    function Row({ label, hint, children }) {
      return h("div", { className: "wbd-row" },
        h("div", null,
          h("div", { className: "wbd-label" }, label),
          hint ? h("div", { className: "wbd-hint" }, hint) : null),
        h("div", { className: "wbd-ctl" }, children));
    }

    function Card({ k, v, cls }) {
      return h("div", { className: "wbd-card" },
        h("div", { className: "wbd-card-k" }, k),
        h("div", { className: cls ? `wbd-card-v ${cls}` : "wbd-card-v" }, v));
    }

    function WeiboSection() {
      const [cfg, setCfg] = useState(null);
      const [saved, setSaved] = useState(null);
      const [status, setStatus] = useState(null);
      const [persona, setPersona] = useState("");
      const [cats, setCats] = useState([]);
      const [subInput, setSubInput] = useState("");
      const [subpInput, setSubpInput] = useState("");
      const [loginMsg, setLoginMsg] = useState("");
      const [doctor, setDoctor] = useState(null);
      const [postPrev, setPostPrev] = useState(null);
      const [personaSaved, setPersonaSaved] = useState("");
      const [busy, setBusy] = useState("");
      const [err, setErr] = useState("");
      const [out, setOut] = useState("");
      const [outTitle, setOutTitle] = useState("");
      const timer = useRef(null);

      const load = useCallback(async () => {
        setErr("");
        try {
          const d = await call("/settings");
          setCfg(d.config);
          setSaved(JSON.stringify(d.config));
          setStatus(d.status);
          setPersona(d.persona?.text || "");
          setPersonaSaved(d.persona?.text || "");
          if (Array.isArray(d.categories)) setCats(d.categories);
        } catch (e) {
          setErr(String(e.message || e));
        }
      }, []);

      useEffect(() => { load(); return () => { if (timer.current) clearInterval(timer.current); }; }, [load]);

      const patch = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
      const patchNight = (k, v) => setCfg((c) => ({ ...c, night: { ...(c.night || {}), [k]: v } }));

      const saveCfg = async () => {
        setBusy("save"); setErr("");
        try {
          const d = await call("/settings", { method: "POST", body: JSON.stringify({ config: cfg }) });
          setCfg(d.config);
          setSaved(JSON.stringify(d.config));
          if (d.status) setStatus(d.status);
          setOutTitle("保存结果");
          setOut(`已保存：${(d.changed || []).join("、") || "（无变化）"}`);
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const doLogin = async () => {
        const sub = subInput.trim();
        const subp = subpInput.trim();
        if (!sub) return;
        setBusy("login"); setErr(""); setLoginMsg("");
        try {
          const d = await call("/login", { method: "POST", body: JSON.stringify({ sub, subp }) });
          setSubInput(""); setSubpInput("");
          setLoginMsg(d.valid
            ? `登录成功${d.screenName ? "：" + d.screenName : ""} · ${d.masked}`
            : (d.note || "存下来了，但校验没过——cookie 可能过期了"));
          await load();
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const refreshCats = async () => {
        setBusy("cats"); setErr("");
        try {
          const d = await call("/categories?refresh=1");
          setCats(d.categories || []);
          setOutTitle("分类列表");
          setOut(`已从微博拉到 ${(d.categories || []).length} 个分类（热搜活动会轮换，所以偶尔刷一次）`);
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const clearDedupe = async () => {
        setBusy("dedupe"); setErr("");
        try {
          const d = await call("/dedupe", { method: "POST" });
          if (d.status) setStatus(d.status);
          setOutTitle("跨轮去重");
          setOut(d.cleared
            ? `已清空去重记录（原来记着 ${d.cleared} 条），下一轮从零重新攒。`
            : "去重记录本来就是空的。");
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const runDoctor = async () => {
        setBusy("doctor"); setErr(""); setDoctor(null);
        try {
          const d = await callSoft("/doctor");
          if (!Array.isArray(d?.items)) throw new Error(d?.error || "自检没有返回结果");
          setDoctor(d);
          setOutTitle("通道自检");
          setOut((d.items || []).map((x) => {
            const mark = x.ok === true ? "✓" : x.ok === null ? "–" : "✗";
            return `${mark} ${x.label}${x.ms ? ` ${x.ms}ms` : ""}`
              + `${x.note ? ` · ${x.note}` : ""}${x.error ? ` · ${x.error}` : ""}`;
          }).join("\n") + (d.cooldown?.active ? `\n\n风控熔断中：还要等 ${d.cooldown.leftMin} 分钟` : ""));
          await load();
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const runDeps = async () => {
        setBusy("deps"); setErr("");
        try {
          const d = await callSoft("/deps");
          const dep = d?.deps;
          if (!dep || !Array.isArray(dep.items)) throw new Error(d?.error || "依赖检查没有返回结果");
          setOutTitle("依赖检查");
          setOut(dep.items.map((x) => {
            const mark = x.ok === true ? "✓" : "✗";
            return `${mark} ${x.label}：${x.detail || ""}`
              + (!x.ok && x.fix ? `\n   → ${x.fix}` : "");
          }).join("\n\n") + `\n\n—— ${dep.hint || ""}`);
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const previewPost = async () => {
        const mode = cfg?.postMode === "topic" ? "topic" : "diary";
        const topic = String(cfg?.postTopic || "DeepSeek");
        setBusy("post"); setErr(""); setPostPrev(null);
        setOutTitle("正在生成发博草稿");
        setOut(mode === "topic"
          ? `模型正在读人设、看 #${topic}# 最近在聊什么，再拟一个讨论……通常 30~60 秒。`
          : "模型正在读人设、把今天的日记总结成一条微博……通常 30~60 秒。");
        try {
          const d = await call(`/post?mode=${mode}&topic=${encodeURIComponent(topic)}`);
          setPostPrev(d);
          setOutTitle(d.mode === "topic" ? `发博草稿 · 超话 #${d.topic}#` : "发博草稿 · 日记总结");
          setOut(`${d.text}\n\n—— ${d.chars} 字 · 每天 ${d.quota?.limit ?? 1} 条`);
        } catch (e) {
          setErr(String(e.message || e));
          setOutTitle(""); setOut("");
        }
        setBusy("");
      };

      const sendPost = async () => {
        setBusy("post"); setErr("");
        try {
          const d = await call("/post", {
            method: "POST",
            body: JSON.stringify({
              confirm: true,
              mode: postPrev?.mode || undefined,
              topic: postPrev?.topic || undefined,
            }),
          });
          setPostPrev(null);
          setOutTitle("发博结果");
          setOut(`已发布 ${d.chars} 字${d.url ? `\n${d.url}` : ""}\n今天已发 ${d.quota?.used ?? 1}/${d.quota?.limit ?? 1} 条`);
          await load();
        } catch (e) {
          const msg = String(e.message || e);
          setErr(msg);
          // 错误也写进结果区：只挂在页面最底部的话，点完按钮会以为「没反应」
          setOutTitle("发博失败");
          setOut(msg);
        }
        setBusy("");
      };

      const viewReplies = async () => {
        setBusy("replies"); setErr("");
        try {
          const d = await call("/replies");
          setOutTitle("最近评论");
          const rows = (d.candidates || []).map((c, i) => `${i + 1}. @${c.author}：${c.text}`
            + (c.postText ? `\n   ↳ 我的微博：${c.postText}` : ""));
          setOut(`${rows.join("\n\n") || "最近没有新的评论"}`
            + `\n\n—— 今天已回 ${d.quota?.used ?? 0}/${d.quota?.limit ?? 0}`
            + ` · 扫了 ${d.posts ?? 0} 篇 / ${d.comments ?? 0} 条评论`);
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const savePersona = async () => {
        setBusy("persona"); setErr("");
        try {
          const d = await call("/persona", { method: "POST", body: JSON.stringify({ content: persona }) });
          setPersonaSaved(persona);
          setOutTitle("保存结果");
          setOut(`已保存人设，${d.chars} 字`);
        } catch (e) { setErr(String(e.message || e)); }
        setBusy("");
      };

      const pollStatus = useCallback(() => {
        if (timer.current) clearInterval(timer.current);
        timer.current = setInterval(async () => {
          try {
            const d = await call("/status");
            setStatus(d);
            if (!d.running) {
              clearInterval(timer.current);
              timer.current = null;
              setBusy("");
              if (d.last) {
                setOutTitle("这一轮的结果");
                setOut((d.last.ok ? "✓ " : "✗ ") + (d.last.summary || d.last.error || "")
                  + (d.last.seconds ? `\n\n耗时 ${d.last.seconds} 秒` : ""));
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 2500);
      }, []);

      const runRound = async (comment) => {
        setBusy("run"); setErr(""); setOut(""); setOutTitle("");
        try {
          const d = await call("/run", { method: "POST", body: JSON.stringify({ comment }) });
          setOutTitle("正在跑");
          setOut(`已起一轮（${d.allowComment ? "本轮可回帖" : "本轮只刷"}${d.topic ? ` · 超话 ${d.topic}` : ""}）\n`
            + "模型在里面看配置、刷内容、判断、写日记……通常 30~90 秒。");
          setStatus((s) => ({ ...(s || {}), running: true }));
          pollStatus();
        } catch (e) {
          setErr(String(e.message || e)); setBusy("");
        }
      };

      const showDiary = async () => {
        setErr("");
        try {
          const d = await call("/diary?lines=120");
          setOutTitle(`最近日记 · ${d.days || 0} 段（她写给自己的随笔）`);
          setOut(d.text || "还没有日记");
        } catch (e) { setErr(String(e.message || e)); }
      };

      if (!cfg) {
        return h("div", { className: "wbd" },
          h("h3", { className: "wbd-title" }, "刷微博"),
          err ? h("div", { className: "wbd-err" }, err) : h("div", { className: "wbd-hint" }, "读取中…"));
      }

      const dirty = JSON.stringify(cfg) !== saved;
      const personaDirty = persona !== personaSaved;
      const st = status || {};
      const windows = Array.isArray(cfg.night?.windows) ? cfg.night.windows : [];
      const running = st.running === true || busy === "run";

      const catIds = Array.isArray(cfg.hotCategories) ? cfg.hotCategories : [];
      const toggleCat = (id) => patch("hotCategories",
        catIds.includes(id) ? catIds.filter((x) => x !== id) : [...catIds, id]);
      const mode = cfg.feedMode || "hot";

      const setWin = (i, k, v) => patchNight("windows", windows.map((w, j) => (j === i ? { ...w, [k]: v } : w)));
      const addWin = () => patchNight("windows", [...windows, { start: "19:00", end: "23:00", wakes: 1 }]);
      const delWin = (i) => {
        const next = windows.filter((_, j) => j !== i);
        patchNight("windows", next.length ? next : [{ start: "19:00", end: "23:00", wakes: 1 }]);
      };

      return h("div", { className: "wbd" },
        h("h3", { className: "wbd-title" }, "刷微博"),

        h("div", { className: "wbd-cards" },
          h(Card, { k: "登录态", v: st.login?.has ? "已登录" : "未登录", cls: st.login?.has ? "wbd-ok" : "wbd-bad" }),
          h(Card, {
            k: "今日回帖",
            v: st.comments ? `${st.comments.today} / ${st.comments.limit}` : "—",
            cls: st.comments && st.comments.today >= st.comments.limit ? "wbd-bad" : "",
          }),
          h(Card, { k: "下一轮", v: st.next || (st.autoRun ? "今天没有了" : "无") }),
          h(Card, { k: "状态", v: running ? "正在刷…" : "空闲", cls: running ? "" : "wbd-ok" }),
          h(Card, {
            k: "通道",
            v: st.channel?.cooldown?.active ? `熔断 ${st.channel.cooldown.leftMin} 分钟` : "正常",
            cls: st.channel?.cooldown?.active ? "wbd-bad" : "wbd-ok",
          })),

        h("div", { className: "wbd-group" }, "账号"),
        h("div", { className: "wbd-rows" },
          h(Row, {
            label: "SUB=",
            hint: "登录 weibo.com → F12 → Application → Cookies，复制 SUB 的值",
          },
            h("input", {
              className: "wbd-input wbd-wide", type: "text", placeholder: "SUB 的值",
              value: subInput, onChange: (e) => setSubInput(e.target.value),
            })),
          h(Row, { label: "SUBP=", hint: "一般是空的，可以留空" },
            h("input", {
              className: "wbd-input wbd-wide", type: "text", placeholder: "SUBP 的值（可留空）",
              value: subpInput, onChange: (e) => setSubpInput(e.target.value),
            }),
            h("button", { className: "wbd-btn", onClick: doLogin, disabled: !!busy || !subInput.trim() },
              busy === "login" ? "校验中…" : "保存并校验")),
          h(Row, { label: "当前账号", hint: "cookie 只存本机（600）" },
            h("span", { className: st.login?.has ? "wbd-ok" : "wbd-bad" },
              st.login?.has
                ? h("span", null,
                  st.account?.screenName ? `@${st.account.screenName}` : "（昵称未取到）",
                  h("span", { className: "wbd-sep", style: { marginLeft: "6px" } }, `uid ${st.account?.uid || "—"}`),
                  h("span", { className: "wbd-sep", style: { marginLeft: "6px" } }, st.login.masked))
                : "还没有 cookie，点上面保存一份")),
          loginMsg ? h("div", { className: "wbd-note wbd-ok" }, loginMsg) : null),

        h("div", { className: "wbd-group" }, "最近一次自检"),
        h("div", { className: "wbd-rows" },
          doctor ? h("div", { className: "wbd-note" },
            (doctor.items || []).map((x) => h("span", {
              key: x.name,
              className: x.ok === true ? "wbd-ok" : x.ok === null ? "wbd-sep" : "wbd-bad",
              style: { marginRight: "12px" },
            }, `${x.label} ${x.ok === true ? "✓" : x.ok === null ? "–" : "✗"}`)),
            h("div", { style: { marginTop: "3px" } },
              `${doctor.ok ? "核心通道正常" : "有核心能力不可用"} · 请求间隔 ${doctor.gapMs ?? "—"}ms`
              + (doctor.cooldown?.active ? ` · 风控熔断还要等 ${doctor.cooldown.leftMin} 分钟` : ""))) : null),

        h("div", { className: "wbd-group" }, "刷取"),
        h("div", { className: "wbd-rows" },
          h(Row, { label: "刷哪里", hint: "热门最适合说话" },
            h("select", {
              className: "wbd-input", value: mode, onChange: (e) => patch("feedMode", e.target.value),
            },
              h("option", { value: "hot" }, "热门"),
              h("option", { value: "timeline" }, "所有关注"),
              h("option", { value: "topic" }, "超话"))),

          mode === "hot"
            ? h(Row, {
              label: "热门分类",
              hint: "每勾一个各拉一段（建议：搞笑+科技）",
            },
              h("div", { style: { display: "flex", flexDirection: "column", gap: "7px", alignItems: "flex-start" } },
                h("div", { className: "wbd-cats" },
                  cats.map((c) => h("label", {
                    key: c.id, className: c.caution ? "wbd-cat wbd-mute" : "wbd-cat",
                  },
                    h("input", {
                      type: "checkbox", checked: catIds.includes(c.id), onChange: () => toggleCat(c.id),
                    }),
                    c.name + (c.caution ? "（慎选）" : "")))),
                h("div", { className: "wbd-ctl" },
                  h("button", {
                    className: "wbd-btn wbd-btn3", onClick: refreshCats, disabled: !!busy,
                  }, busy === "cats" ? "拉取中…" : "刷新分类"),
                  h("span", { className: "wbd-sep" }, `已勾 ${catIds.length} 个` + (catIds.length ? "" : "（空则用默认）")))))
            : null,

          mode === "topic"
            ? h(Row, {
              label: "刷哪些超话",
              hint: "逗号分隔，不用预先关注",
            },
              h("input", {
                className: "wbd-input wbd-wide", type: "text", placeholder: "留空 = 退回热门",
                value: cfg.autoTopic || "", onChange: (e) => patch("autoTopic", e.target.value),
              }))
            : null,

          mode === "topic"
            ? h(Row, { label: "超话翻几页", hint: "每页约 10 条" },
              h("input", {
                className: "wbd-input", type: "number", min: 1, max: 5, value: cfg.pageLimit,
                onChange: (e) => patch("pageLimit", num(e.target.value, 2)),
              }))
            : null,

          h(Row, { label: "每轮读几条", hint: "1~50" },
            h("input", {
              className: "wbd-input", type: "number", min: 1, max: 50, value: cfg.readPerRound,
              onChange: (e) => patch("readPerRound", num(e.target.value, 10)),
            })),
          h(Row, { label: "单条正文截断", hint: "超过就截断，再交给模型" },
            h("input", {
              className: "wbd-input", type: "number", min: 40, max: 2000, step: 20, value: cfg.maxTextChars,
              onChange: (e) => patch("maxTextChars", num(e.target.value, 160)),
            })),

          h(Row, {
            label: "跨轮去重",
            hint: "剔掉最近几轮读过的帖子；0 = 关",
          },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 50, step: 1,
              value: cfg.dedupeRounds ?? 5,
              onChange: (e) => patch("dedupeRounds", num(e.target.value, 5)),
            }),
            h("span", { className: "wbd-sep" },
              st.dedupe?.enabled
                ? `已挡 ${st.dedupe.rememberedIds ?? 0} 条（近 ${st.dedupe.effectiveRounds ?? 0} 轮）`
                : "已关闭"),
            h("button", {
              className: "wbd-btn wbd-btn3", disabled: !!busy,
              onClick: clearDedupe,
              title: "清空后最近几轮读过的帖子不会再被挡（下一轮从零重新攒）",
            }, "清空记录")),
          h(Row, { label: "看图", hint: "每轮最多 3 张，视频只看封面" },
            h("input", {
              type: "checkbox", checked: cfg.visionEnabled === true,
              onChange: (e) => patch("visionEnabled", e.target.checked),
            }))),

        h("div", { className: "wbd-group" }, "回帖"),
        h("div", { className: "wbd-rows" },
          h(Row, { label: "允许自动回帖", hint: "关掉只刷不说" },
            h("input", {
              type: "checkbox", checked: cfg.autoComment === true,
              onChange: (e) => patch("autoComment", e.target.checked),
            })),
          h(Row, { label: "回帖概率", hint: "每轮按这个概率决定说不说" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 1, step: 0.05, value: cfg.commentChance,
              onChange: (e) => patch("commentChance", num(e.target.value, 0.35)),
            })),
          h(Row, { label: "每天最多几条", hint: "硬上限" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 20, value: cfg.commentDailyLimit,
              onChange: (e) => patch("commentDailyLimit", num(e.target.value, 3)),
            })),
          h(Row, { label: "两条之间至少隔", hint: "分钟，太密易限流" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 1440, step: 5, value: cfg.commentMinGapMin,
              onChange: (e) => patch("commentMinGapMin", num(e.target.value, 30)),
            })),
          h(Row, { label: "每轮最多评", hint: "条，防止一轮刷满" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 3, value: cfg.commentPerRound ?? 1,
              onChange: (e) => patch("commentPerRound", num(e.target.value, 1)),
            }))),

        h("div", { className: "wbd-group" }, "回评"),
        h("div", { className: "wbd-rows" },
          h(Row, { label: "自动回评", hint: "回复别人在她微博下的评论" },
            h("input", {
              type: "checkbox", checked: cfg.autoReplyComment === true,
              onChange: (e) => patch("autoReplyComment", e.target.checked),
            })),
          h(Row, { label: "每天最多回", hint: "条，硬上限" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 10, value: cfg.autoReplyPerDay ?? 2,
              onChange: (e) => patch("autoReplyPerDay", num(e.target.value, 2)),
            })),
          h(Row, { label: "只回最近", hint: "分钟内的评论（720 = 12 小时）" },
            h("input", {
              className: "wbd-input", type: "number", min: 10, max: 10080, step: 10,
              value: cfg.autoReplyMaxAgeMin ?? 720,
              onChange: (e) => patch("autoReplyMaxAgeMin", num(e.target.value, 720)),
            })),
          h(Row, { label: "最近评论", hint: `今天已回 ${st.replies?.used ?? 0}/${st.replies?.limit ?? 0} 条` },
            h("button", { className: "wbd-btn wbd-btn3", onClick: viewReplies, disabled: !!busy },
              busy === "replies" ? "读取中…" : "看看有没有"))),

        h("div", { className: "wbd-group" }, "发博"),
        h("div", { className: "wbd-rows" },
          h(Row, {
            label: "发博模式",
            hint: "日记模式总结当天日记；话题模式在超话里发一个讨论",
          },
            h("select", {
              className: "wbd-input", value: cfg.postMode || "diary",
              onChange: (e) => patch("postMode", e.target.value),
            },
              h("option", { value: "diary" }, "日记模式"),
              h("option", { value: "topic" }, "超话话题"))),
          (cfg.postMode || "diary") === "topic"
            ? h(Row, { label: "发到哪个超话", hint: "不用带 #，例如 DeepSeek" },
              h("input", {
                className: "wbd-input wbd-wide", type: "text", placeholder: "DeepSeek",
                value: cfg.postTopic || "", onChange: (e) => patch("postTopic", e.target.value),
              }))
            : null,
          h(Row, {
            label: "每日定时",
            hint: `到点按当前模式生成并发出去（每天 ${st.posts?.limit ?? 1} 条）`,
          },
            h("input", {
              type: "checkbox", checked: cfg.autoPost === true,
              onChange: (e) => patch("autoPost", e.target.checked),
            }),
            h("input", {
              className: "wbd-input wbd-time", type: "time", value: cfg.postAt || "22:30",
              onChange: (e) => patch("postAt", e.target.value),
            })),
          h(Row, { label: "每天最多发", hint: "条，硬上限" },
            h("input", {
              className: "wbd-input", type: "number", min: 0, max: 3, value: cfg.postDailyLimit ?? 2,
              onChange: (e) => patch("postDailyLimit", num(e.target.value, 2)),
            })),
          h(Row, {
            label: "手动发博",
            hint: "先生成总结草稿，确认后才会发出去",
          },
            postPrev
              ? h("button", { className: "wbd-btn", onClick: sendPost, disabled: !!busy },
                busy === "post" ? "发送中…" : "确认发送")
              : h("button", { className: "wbd-btn wbd-btn3", onClick: previewPost, disabled: !!busy },
                busy === "post" ? "生成中…" : "生成总结草稿")),
          h("div", { className: "wbd-note" }, `今天已发 ${st.posts?.used ?? 0}/${st.posts?.limit ?? 1} 条`)),

        h("div", { className: "wbd-group" }, "口味"),
        h("div", { className: "wbd-hint", style: { marginBottom: "6px" } },
          "写进每轮提示词，用来判断值不值得接一句；留空就不提。"),
        h("div", { className: "wbd-label", style: { marginBottom: "4px" } }, "爱看"),
        h("textarea", {
          className: "wbd-textarea wbd-short", spellCheck: false,
          placeholder: "例：小动物、冷幽默、生活琐事",
          value: cfg.likes || "", onChange: (e) => patch("likes", e.target.value),
        }),
        h("div", { className: "wbd-label", style: { marginTop: "10px", marginBottom: "4px" } }, "不爱看"),
        h("textarea", {
          className: "wbd-textarea wbd-short", spellCheck: false,
          placeholder: "例：明星八卦、性别对立、骂战",
          value: cfg.dislikes || "", onChange: (e) => patch("dislikes", e.target.value),
        }),

        h("div", { className: "wbd-group" }, "作息"),
        h("div", { className: "wbd-rows" },
          h(Row, { label: "自动运行", hint: "关掉只能手动刷" },
            h("input", {
              type: "checkbox", checked: cfg.autoRun === true,
              onChange: (e) => patch("autoRun", e.target.checked),
            })),
          h(Row, { label: "醒来窗口", hint: "窗口内随机醒 n 次，每次刷一轮" },
            h("div", { className: "wbd-win" },
              h("span", { className: "wbd-sep" }, `${windows.length} 个`),
              h("button", { className: "wbd-btn wbd-btn3", onClick: addWin }, "添加窗口"))),
          ...windows.map((w, i) => h("div", { className: "wbd-row", key: `w${i}` },
            h("div", null,
              h("div", { className: "wbd-label" }, `窗口 ${i + 1}`),
              h("div", { className: "wbd-hint" }, "开始 / 结束 / 次数")),
            h("div", { className: "wbd-ctl" },
              h("input", {
                className: "wbd-input wbd-time", type: "time", value: w.start || "19:00",
                onChange: (e) => setWin(i, "start", e.target.value),
              }),
              h("span", { className: "wbd-sep" }, "→"),
              h("input", {
                className: "wbd-input wbd-time", type: "time", value: w.end || "23:00",
                onChange: (e) => setWin(i, "end", e.target.value),
              }),
              h("input", {
                className: "wbd-input", type: "number", min: 0, max: 6, style: { minWidth: "64px" },
                value: w.wakes, onChange: (e) => setWin(i, "wakes", num(e.target.value, 1)),
              }),
              h("button", { className: "wbd-btn wbd-btn3", onClick: () => delWin(i) }, "删除")))),
          h("div", { className: "wbd-row" },
            h("div", null, h("div", { className: "wbd-label" }, "两次醒来至少隔")),
            h("div", { className: "wbd-ctl" },
              h("input", {
                className: "wbd-input", type: "number", min: 0, max: 1440, step: 5,
                value: cfg.night?.minGapMin ?? 20,
                onChange: (e) => patchNight("minGapMin", num(e.target.value, 20)),
              }),
              h("span", { className: "wbd-sep" }, "分钟"))),
          h(Row, { label: "一轮最长等", hint: "分钟，超时杀掉" },
            h("input", {
              className: "wbd-input", type: "number", min: 1, max: 60, value: cfg.runTimeoutMin,
              onChange: (e) => patch("runTimeoutMin", num(e.target.value, 10)),
            }))),

        h("div", { className: "wbd-group" }, "人设"),
        h("div", { className: "wbd-hint", style: { marginBottom: "6px" } },
          "每轮自动读取。"),
        h("textarea", {
          className: "wbd-textarea", value: persona, spellCheck: false,
          onChange: (e) => setPersona(e.target.value),
        }),

        h("div", { className: "wbd-actions" },
          h("button", { className: "wbd-btn", onClick: saveCfg, disabled: !!busy || !dirty },
            busy === "save" ? "保存中…" : "保存配置"),
          dirty ? h("span", { className: "wbd-dirty" }, "● 有改动没保存") : null,
          h("button", { className: "wbd-btn wbd-btn2", onClick: savePersona, disabled: !!busy || !personaDirty },
            busy === "persona" ? "保存中…" : "保存人设"),
          personaDirty ? h("span", { className: "wbd-dirty" }, "● 人设有改动") : null,
          h("button", { className: "wbd-btn wbd-btn2", onClick: load, disabled: !!busy }, "重新读取")),

        h("div", { className: "wbd-actions", style: { borderTop: "none", paddingTop: 0, marginTop: "8px" } },
          h("button", { className: "wbd-btn", onClick: () => runRound(""), disabled: running },
            running ? "正在跑…" : "刷一轮（掷骰评论）"),
          h("button", { className: "wbd-btn wbd-btn2", onClick: () => runRound("yes"), disabled: running }, "刷一轮 · 允许回帖"),
          h("button", { className: "wbd-btn wbd-btn2", onClick: () => runRound("no"), disabled: running }, "刷一轮 · 不允许回帖"),
          h("button", { className: "wbd-btn wbd-btn2", onClick: showDiary, disabled: !!busy }, "看日记"),
          h("button", { className: "wbd-btn wbd-btn3", onClick: runDoctor, disabled: !!busy },
            busy === "doctor" ? "检测中…" : "运行自检"),
          h("button", { className: "wbd-btn wbd-btn3", onClick: runDeps, disabled: !!busy },
            busy === "deps" ? "检查中…" : "检查依赖")),

        err ? h("div", { className: "wbd-err" }, err) : null,
        out ? h("div", null,
          outTitle ? h("div", { className: "wbd-hint", style: { marginTop: "12px" } }, outTitle) : null,
          h("div", { className: "wbd-out" }, out)) : null);
    }

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return;
      const el = document.createElement("style");
      el.dataset.tag = CSS_TAG;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    const inject = ["slots"];
    const NS = "dsh-weibo-dive";

    function apply(ctx) {
      ensureCss();
      ctx.effect(
        () => ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: NS, order: 9, label: () => "刷微博" },
            WeiboSection,
          ), "dsh-weibo-dive: settings section"),
        "dsh-weibo-dive: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.WeiboSection = WeiboSection;
    return module.exports;
  },
});
