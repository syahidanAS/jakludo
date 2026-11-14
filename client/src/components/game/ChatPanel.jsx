import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from '../Icon';
import PlayerAvatar from '../PlayerAvatar';

const DEFAULT_QUICK_CHATS = ['Semangat! 🔥', 'GG! 👏', 'Ampun bang! 😂', 'Jangan makan bidakku! 😭', 'Maju terus! 🚀'];

// Obrolan room: dipakai di panel samping (desktop) dan bottom sheet (HP)
export default function ChatPanel({ chats, playerId, onSend, autoFocus = false, quickChats = DEFAULT_QUICK_CHATS }) {
  const [text, setText] = useState('');
  const [replyTarget, setReplyTarget] = useState(null);
  const [highlightedId, setHighlightedId] = useState(null);
  const inputId = useId();
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const itemRefs = useRef(new Map());
  const highlightTimerRef = useRef(null);

  // Gulir daftar pesan saja (bukan seluruh halaman) ke pesan terbaru
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [chats]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => () => clearTimeout(highlightTimerRef.current), []);

  const submit = e => {
    e.preventDefault();
    if (onSend(text, replyTarget)) {
      setText('');
      setReplyTarget(null);
    }
  };

  const sendQuick = q => {
    if (onSend(q, replyTarget)) setReplyTarget(null);
  };

  const startReply = msg => {
    setReplyTarget({
      id: msg.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderColor: msg.senderColor,
      text: msg.text
    });
    inputRef.current?.focus();
  };

  const jumpToMessage = targetId => {
    const node = itemRefs.current.get(String(targetId));
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setHighlightedId(targetId);
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 1400);
  };

  const replyName = r => (r.senderId === playerId ? 'Kamu' : r.senderName);

  return (
    <div className="chat">
      <ol className="chat__list" ref={listRef} aria-label="Pesan obrolan">
        {chats.length === 0 ? (
          <li className="chat__empty muted">Belum ada obrolan. Sapa teman bermainmu!</li>
        ) : (
          chats.map(msg => {
            const mine = msg.senderId === playerId;
            const isHighlighted = highlightedId !== null && String(highlightedId) === String(msg.id);
            return (
              <li
                key={msg.id}
                ref={el => {
                  const k = String(msg.id);
                  if (el) itemRefs.current.set(k, el);
                  else itemRefs.current.delete(k);
                }}
                className={`chat__msg color-${msg.senderColor} ${mine ? 'is-mine' : ''} ${isHighlighted ? 'is-highlighted' : ''}`}
              >
                <span className="chat__meta">
                  {!mine && msg.senderAvatar && (
                    <PlayerAvatar
                      avatar={msg.senderAvatar}
                      name={msg.senderName}
                      size={20}
                      className="avatar chat__avatar"
                    />
                  )}
                  <strong className="chat__sender">{mine ? 'Kamu' : msg.senderName}</strong>
                  <span className="muted">{msg.time}</span>
                </span>
                <div className="chat__row">
                  <div className="chat__bubble">
                    {msg.replyTo && (
                      <button
                        type="button"
                        className={`chat__quote color-${msg.replyTo.senderColor || msg.senderColor}`}
                        onClick={() => jumpToMessage(msg.replyTo.id)}
                        title="Lihat pesan yang dibalas"
                      >
                        <strong className="chat__quote-sender">{replyName(msg.replyTo)}</strong>
                        <span className="chat__quote-text">{msg.replyTo.text}</span>
                      </button>
                    )}
                    <span className="chat__text">{msg.text}</span>
                  </div>
                  <button
                    type="button"
                    className="chat__reply-btn"
                    onClick={() => startReply(msg)}
                    aria-label={`Balas pesan dari ${replyName(msg)}`}
                    title="Balas pesan ini"
                  >
                    <Icon name="reply" size={14} />
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ol>

      <div className="chat__quick" role="group" aria-label="Pesan cepat">
        {quickChats.map(q => (
          <button key={q} type="button" className="chip" onClick={() => sendQuick(q)}>{q}</button>
        ))}
      </div>

      {replyTarget && (
        <div className={`chat__reply-bar color-${replyTarget.senderColor}`} role="status">
          <div className="chat__reply-info">
            <span className="chat__reply-label">Membalas <strong>{replyName(replyTarget)}</strong></span>
            <span className="chat__reply-snippet">{replyTarget.text}</span>
          </div>
          <button
            type="button"
            className="chat__reply-cancel"
            onClick={() => { setReplyTarget(null); inputRef.current?.focus(); }}
            aria-label="Batalkan balasan"
            title="Batalkan balasan"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <form className="chat__form" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">Tulis pesan</label>
        <input
          id={inputId}
          ref={inputRef}
          className="input"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && replyTarget) {
              e.stopPropagation();
              e.nativeEvent.stopPropagation();
              setReplyTarget(null);
            }
          }}
          maxLength={140}
          placeholder={replyTarget ? `Balas ${replyName(replyTarget)}...` : 'Tulis pesan...'}
          autoComplete="off"
        />
        <button type="submit" className="btn btn--primary" disabled={!text.trim()}>Kirim</button>
      </form>
    </div>
  );
}
