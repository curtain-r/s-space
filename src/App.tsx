import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

type TerminalOutput = {
  session_id: number;
  data: string;
};

type TerminalExit = {
  session_id: number;
};

function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalStatus, setTerminalStatus] = useState<"idle" | "starting" | "ready" | "closed" | "error">("idle");
  const terminalHostRef = useRef<HTMLDivElement | null>(null);

  const repoName = repoPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "未选择仓库";

  const chooseRepository = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择一个代码仓库",
    });

    if (typeof selected === "string") {
      setRepoPath(selected);
      setTerminalOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!terminalOpen || !terminalHostRef.current || !repoPath) {
      return;
    }

    let disposed = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let currentSessionId: number | undefined;
    let dataDisposable: { dispose: () => void } | undefined;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#0b1020",
        foreground: "#d7e0ff",
        cursor: "#8fb7ff",
        selectionBackground: "#26365f",
        black: "#151923",
        blue: "#7aa2f7",
        cyan: "#7dcfff",
        green: "#9ece6a",
        magenta: "#bb9af7",
        red: "#f7768e",
        white: "#c0caf5",
        yellow: "#e0af68",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalHostRef.current);

    const fitTerminal = () => {
      try {
        fitAddon.fit();
        if (currentSessionId) {
          void invoke("terminal_resize", {
            sessionId: currentSessionId,
            rows: term.rows,
            cols: term.cols,
          });
        }
      } catch {
        // xterm can throw while the panel is animating or hidden.
      }
    };

    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(terminalHostRef.current);
    window.addEventListener("resize", fitTerminal);

    const startTerminal = async () => {
      try {
        setTerminalStatus("starting");
        unlistenOutput = await listen<TerminalOutput>("terminal-output", (event) => {
          if (event.payload.session_id === currentSessionId) {
            term.write(event.payload.data);
          }
        });
        unlistenExit = await listen<TerminalExit>("terminal-exit", (event) => {
          if (event.payload.session_id === currentSessionId) {
            setTerminalStatus("closed");
            term.writeln("\r\n[terminal exited]");
          }
        });

        fitTerminal();
        currentSessionId = await invoke<number>("terminal_start", {
          cwd: repoPath,
          rows: term.rows || 32,
          cols: term.cols || 100,
        });

        if (disposed) {
          void invoke("terminal_close", { sessionId: currentSessionId });
          return;
        }

        setTerminalStatus("ready");
        term.writeln(`S Space terminal · ${repoPath}`);
        term.writeln("输入命令开始工作，例如：claude code");
        term.writeln("");

        dataDisposable = term.onData((data) => {
          if (currentSessionId) {
            void invoke("terminal_write", { sessionId: currentSessionId, data });
          }
        });
      } catch (error) {
        setTerminalStatus("error");
        term.writeln(`\r\n[terminal error] ${String(error)}`);
      }
    };

    void startTerminal();

    return () => {
      disposed = true;
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitTerminal);
      if (currentSessionId) {
        void invoke("terminal_close", { sessionId: currentSessionId });
      }
      term.dispose();
      setTerminalStatus("idle");
    };
  }, [repoPath, terminalOpen]);

  return (
    <main className="app-shell">
      <section className="workspace-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">AI native desktop MVP</p>
            <h1>S Space</h1>
          </div>
          <button className="secondary-button" type="button" onClick={() => setTerminalOpen((open) => !open)}>
            {terminalOpen ? "收起终端" : "展开终端"}
          </button>
        </header>

        <div className="hero-card">
          <div className="hero-copy">
            <span className="status-pill">{repoPath ? "仓库已选择" : "等待选择仓库"}</span>
            <h2>选择一个仓库，然后在右侧终端里开始执行任务。</h2>
            <p>
              这个 MVP 先把高性能桌面窗口、仓库上下文和交互式终端跑通。后续的 App Content、AI 工作流和仓库问答能力都可以在这个壳上继续长出来。
            </p>
          </div>
          <button className="primary-button" type="button" onClick={chooseRepository}>
            {repoPath ? "切换仓库" : "选择仓库"}
          </button>
        </div>

        <section className="repo-card">
          <div className="repo-icon">{repoPath ? repoName.slice(0, 2).toUpperCase() : "--"}</div>
          <div className="repo-details">
            <p className="label">当前仓库</p>
            <h3>{repoName}</h3>
            <code>{repoPath ?? "尚未选择本地仓库"}</code>
          </div>
        </section>

        <section className="content-placeholder">
          <p className="label">App Content</p>
          <h3>这里先留作下一步产品内容区</h3>
          <p>
            你可以先在右侧终端运行 Claude Code 或其他 CLI，对所选仓库执行任务；等方向确定后，再把问答、任务流、上下文面板逐步放进这个区域。
          </p>
        </section>
      </section>

      <aside className={`terminal-panel ${terminalOpen ? "open" : "collapsed"}`}>
        <button className="terminal-tab" type="button" onClick={() => setTerminalOpen((open) => !open)}>
          <span>Terminal</span>
          <strong>{terminalOpen ? "›" : "‹"}</strong>
        </button>
        <div className="terminal-body" aria-hidden={!terminalOpen}>
          <div className="terminal-header">
            <div>
              <p>终端</p>
              <span>{repoPath ? repoName : "请先选择仓库"}</span>
            </div>
            <span className={`terminal-status ${terminalStatus}`}>{terminalStatus}</span>
          </div>
          {repoPath ? (
            <div className="terminal-host" ref={terminalHostRef} />
          ) : (
            <div className="empty-terminal">
              <p>选择仓库后会在这里启动交互式终端。</p>
              <button type="button" onClick={chooseRepository}>选择仓库</button>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

export default App;
