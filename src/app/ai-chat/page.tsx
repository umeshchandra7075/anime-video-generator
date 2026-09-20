"use client";

import { useState, useRef, useEffect } from "react";
import { api, ApiRequestError } from "@/lib/api/client";
import { AppNavbar } from "@/components/app/AppNavbar";
import { Textarea } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function AiChatPage() {
  const { show } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const data = await api.post<{ reply: string }>("/api/ai-chat", { messages: next });
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (err) {
      const msg = err instanceof ApiRequestError ? err.message : "AI request timed out. Please try again.";
      show(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-ink-950">
      <AppNavbar />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8">
        <h1 className="font-display text-3xl text-paper">Brainstorm with AI</h1>
        <p className="mt-2 text-sm text-paper/60">
          Talk through story ideas, characters, or scenes before you start a project.
        </p>

        <div className="mt-6 flex-1 space-y-4 overflow-y-auto rounded-sm border border-ink-700 bg-ink-900 p-6">
          {messages.length === 0 && (
            <p className="text-sm text-paper/40">
              Try: &ldquo;Give me three anime story ideas about a rainy midnight encounter.&rdquo;
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
              <span
                className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-sm px-4 py-2.5 text-left text-sm ${
                  m.role === "user" ? "bg-lantern-500 text-ink-950" : "border border-ink-600 text-paper/90"
                }`}
              >
                {m.content}
              </span>
            </div>
          ))}
          {loading && <p className="text-xs text-paper/40">Thinking...</p>}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={send} className="mt-4 flex gap-3">
          <Textarea
            rows={2}
            className="flex-1"
            placeholder="Ask for story ideas, character concepts, scene inspiration..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(e);
              }
            }}
          />
          <Button type="submit" disabled={loading || !input.trim()}>
            {loading ? "..." : "Send"}
          </Button>
        </form>
      </div>
    </main>
  );
}
