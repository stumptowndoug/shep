import { useState } from "react";
import { ClipboardList, MessageCircle } from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import { answerCursorRequest, cancelTurn } from "../../lib/acp/chatSessions";
import { validCursorOutcome, type CursorOutcome } from "../../lib/acp/cursorProtocol";
import type { ChatItem } from "../../lib/acp/chatModel";

type RequestItem = Extract<ChatItem, { kind: "cursor_request" }>;

export default function CursorRequestCard({ chatId, item }: { chatId: number; item: RequestItem }) {
  const { request } = item;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const respond = (outcome: CursorOutcome) => {
    if (answerCursorRequest(chatId, item.id, outcome)) setSubmitted(true);
  };
  const response: CursorOutcome = request.kind === "question" ? {
    outcome: "answered", answers: request.questions.map(question => ({ questionId: question.id, selectedOptionIds: selected[question.id] ?? [] })),
  } : { outcome: "accepted" };
  const Icon = request.kind === "plan" ? ClipboardList : MessageCircle;

  return (
    <section className="chat-approval chat-cursor-request" aria-label={request.kind === "plan" ? "Cursor plan approval" : "Cursor questions"}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelTurn(chatId); } }}>
      <div className="chat-cursor-request__title"><Icon size={16} aria-hidden="true" /><strong>{request.title}</strong></div>
      <div className="chat-cursor-request__body">
        {request.kind === "plan" ? <>
          {request.overview && <p className="chat-cursor-request__overview">{request.overview}</p>}
          <ChatMarkdown text={request.plan} />
          {request.todos.length > 0 && <ul className="chat-cursor-request__todos">
            {request.todos.map((todo, index) => <li key={todo.id ?? index} className={`chat-plan__entry--${todo.status}`}>{todo.content}</li>)}
          </ul>}
        </> : request.questions.map(question => (
          <fieldset key={question.id} className="chat-question" disabled={submitted}>
            <legend>{question.prompt}</legend>
            {question.allowMultiple && <p className="chat-question__hint">Choose one or more.</p>}
            <div className="chat-question__options">
              {question.options.map(option => (
                <label key={option.id} className="chat-question__option">
                  <input type={question.allowMultiple ? "checkbox" : "radio"} name={`${item.id}:${question.id}`}
                    checked={(selected[question.id] ?? []).includes(option.id)} onChange={() => setSelected(previous => {
                      const choices = previous[question.id] ?? [];
                      return { ...previous, [question.id]: question.allowMultiple
                        ? choices.includes(option.id) ? choices.filter(id => id !== option.id) : [...choices, option.id]
                        : [option.id] };
                    })} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="chat-approval__actions">
        <button type="button" className="btn-secondary" disabled={submitted}
          onClick={() => respond(request.kind === "plan" ? { outcome: "rejected" } : { outcome: "skipped" })}>
          {request.kind === "plan" ? "Reject plan" : "Skip"}
        </button>
        <button type="button" className="btn-primary" disabled={submitted || !validCursorOutcome(request, response)} onClick={() => respond(response)}>
          {request.kind === "plan" ? "Accept plan" : "Send answers"}
        </button>
      </div>
    </section>
  );
}
