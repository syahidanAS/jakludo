import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../components/Modal';
import { useBackHandler } from '../backHandlers';
import Icon from '../components/Icon';
import VoiceNotePlayer, { formatDuration } from './VoiceNotePlayer';
import {
  ChatReplyBanner,
  ChatReplyButton,
  ChatReplyQuote,
  useSocialChatReply
} from './ChatReplyParts';
import {
  compressImage,
  isAvatarUrl,
  MAX_VOICE_DURATION_MS,
  startVoiceRecording
} from './media';
import { sound } from '../sound';

function UserAvatar({ user, className = 'social-avatar', size = 38 }) {
  const val = user?.avatar;
  if (isAvatarUrl(val)) {
    return <img src={val} alt="" width={size} height={size} className={className} />;
  }
  const initial = user?.name?.slice(0, 1).toUpperCase();
  return (
    <span className={className} aria-hidden="true">
      {initial || <Icon name="pawn" size={Math.round(size * 0.45)} />}
    </span>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function previewDirectMessage(msg, currentUserId) {
  if (!msg) return '';
  const prefix = msg.senderId === currentUserId ? 'Kamu: ' : '';
  if (msg.type === 'image') return `${prefix}[Foto]${msg.text ? ` — ${msg.text}` : ''}`;
  if (msg.type === 'audio') return `${prefix}[Pesan suara]`;
  return `${prefix}${msg.text || ''}`;
}

function DirectChatView({ friend, currentUser, social, onBack, onViewProfile }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [error, setError] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState('');

  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const recorderRef = useRef(null);
  const recordTimerRef = useRef(null);

  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastMediaRefetchRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const {
    replyTarget,
    highlightedId,
    registerItemRef,
    startReply,
    clearReply,
    jumpToMessage
  } = useSocialChatReply(inputRef);

  const friendId = friend.userId;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const fetchInitialMessages = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await social.actions.getDirectMessages(friendId);
      setMessages(res.messages);
      setHasMore(res.hasMore);
      stickToBottomRef.current = true;
      scrollToBottom();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [friendId, social.actions, scrollToBottom]);

  useEffect(() => {
    social.actions.setActiveDmFriend(friendId);
    fetchInitialMessages();
    return () => {
      social.actions.setActiveDmFriend('');
    };
  }, [friendId, social.actions, fetchInitialMessages]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (recorderRef.current) {
        recorderRef.current.cancel();
        recorderRef.current = null;
      }
    };
  }, []);

  // Terima pesan private baru secara realtime via WebSocket
  useEffect(() => {
    return social.subscribeGroupEvents((event, payload) => {
      if (
        event === 'dm:message' &&
        ((payload?.senderId === friendId && payload?.recipientId === currentUser?.id) ||
          (payload?.senderId === currentUser?.id && payload?.recipientId === friendId))
      ) {
        setMessages(prev => {
          if (prev.some(m => m.id === payload.id)) return prev;
          return [...prev, payload];
        });
        if (stickToBottomRef.current || payload.senderId === currentUser?.id) {
          scrollToBottom();
        }
      }
    });
  }, [friendId, currentUser?.id, social, scrollToBottom]);

  const onScrollList = () => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
  };

  const loadOlder = async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;
    sound.playClick();
    setLoadingOlder(true);
    setError('');
    const el = listRef.current;
    const prevScrollHeight = el ? el.scrollHeight : 0;
    try {
      const res = await social.actions.getDirectMessages(friendId, oldestId);
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const older = res.messages.filter(m => !existingIds.has(m.id));
        return [...older, ...prev];
      });
      setHasMore(res.hasMore);
      requestAnimationFrame(() => {
        if (el) {
          el.scrollTop = el.scrollHeight - prevScrollHeight;
        }
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleMediaError = useCallback(() => {
    const now = Date.now();
    if (now - lastMediaRefetchRef.current < 15000) return;
    lastMediaRefetchRef.current = now;
    social.actions
      .getDirectMessages(friendId)
      .then(res => {
        setMessages(res.messages);
        setHasMore(res.hasMore);
      })
      .catch(() => {});
  }, [friendId, social.actions]);

  const appendMessage = useCallback(
    msg => {
      if (!msg?.id) return;
      setMessages(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
      scrollToBottom();
    },
    [scrollToBottom]
  );

  const onSendText = async e => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || sending || uploadingMedia) return;
    sound.playClick();
    setSending(true);
    setError('');
    try {
      const msg = await social.actions.sendDirectMessage(friendId, clean, replyTarget?.id || null);
      setText('');
      clearReply();
      appendMessage(msg);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const onSelectPhoto = async e => {
    const rawFile = e.target.files?.[0];
    e.target.value = '';
    if (!rawFile || uploadingMedia) return;
    sound.playClick();
    setUploadingMedia(true);
    setError('');
    try {
      const compressed = await compressImage(rawFile);
      const caption = text.trim();
      const msg = await social.actions.sendDirectMedia(friendId, {
        file: compressed.file,
        kind: 'image',
        text: caption,
        replyToId: replyTarget?.id || null
      });
      if (caption) setText('');
      clearReply();
      appendMessage(msg);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadingMedia(false);
    }
  };

  const sendRecordedVoice = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setUploadingMedia(true);
    setError('');
    try {
      const result = await rec.stop();
      if (!result) return;
      const caption = text.trim();
      const msg = await social.actions.sendDirectMedia(friendId, {
        file: result.file,
        kind: 'audio',
        durationMs: result.durationMs,
        text: caption,
        replyToId: replyTarget?.id || null
      });
      if (caption) setText('');
      clearReply();
      appendMessage(msg);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadingMedia(false);
      setRecordElapsedMs(0);
    }
  }, [friendId, text, replyTarget, clearReply, social.actions, appendMessage]);

  const onStartVoice = async () => {
    if (recording || uploadingMedia) return;
    sound.playClick();
    setError('');
    try {
      const rec = await startVoiceRecording({
        onMaxDuration: () => {
          sendRecordedVoice();
        }
      });
      recorderRef.current = rec;
      setRecording(true);
      setRecordElapsedMs(0);
      recordTimerRef.current = setInterval(() => {
        if (recorderRef.current) {
          setRecordElapsedMs(recorderRef.current.getElapsedMs());
        }
      }, 250);
    } catch (err) {
      setError(err.message);
    }
  };

  const onCancelVoice = () => {
    sound.playClick();
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.cancel();
      recorderRef.current = null;
    }
    setRecording(false);
    setRecordElapsedMs(0);
  };

  return (
    <div className="group-detail">
      <div className="group-detail__top">
        <button
          type="button"
          className="btn btn--secondary btn--sm dm-back-btn"
          onClick={() => {
            sound.playClick();
            onBack();
          }}
        >
          <Icon name="arrow-left" size={16} />
          <span className="dm-back-label">Daftar teman</span>
        </button>

        <div className="dm-header-peer">
          <div className="social-avatar-wrap">
            <UserAvatar user={friend} size={36} />
            <span
              className={`status-dot ${friend.online ? 'status-dot--online' : 'status-dot--offline'}`}
              aria-hidden="true"
            />
          </div>
          <div className="dm-header-peer__info">
            <strong>
              {onViewProfile ? (
                <button
                  type="button"
                  className="user-link"
                  onClick={() => {
                    sound.playClick();
                    onViewProfile(friend.userId);
                  }}
                >
                  {friend.name}
                </button>
              ) : (
                friend.name
              )}
            </strong>
            <span className="muted">
              @{friend.username} ·{' '}
              <span className={friend.online ? 'text-online' : ''}>
                {friend.online ? 'Online' : 'Offline'}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="group-chat">
        <div className="group-chat__messages" ref={listRef} onScroll={onScrollList}>
          {hasMore && (
            <div className="group-chat__more">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={loadingOlder}
                onClick={loadOlder}
              >
                {loadingOlder ? 'Memuat...' : 'Muat pesan sebelumnya'}
              </button>
            </div>
          )}

          {loading && messages.length === 0 ? (
            <p className="state-msg" role="status">
              <span className="spinner" aria-hidden="true" /> Memuat obrolan private...
            </p>
          ) : messages.length === 0 ? (
            <p className="state-msg muted">
              Belum ada pesan dengan {friend.name}. Kirim sapaan pertamamu!
            </p>
          ) : (
            messages.map(msg => {
              const isMe = currentUser && msg.senderId === currentUser.id;
              const senderName = isMe ? 'Kamu' : msg.sender?.name || friend.name;
              const isHighlighted = highlightedId === msg.id;
              return (
                <div
                  key={msg.id}
                  ref={el => registerItemRef(msg.id, el)}
                  className={`gmsg ${isMe ? 'gmsg--me' : 'gmsg--other'} ${isHighlighted ? 'gmsg--highlighted' : ''}`}
                >
                  {!isMe && (
                    <UserAvatar
                      user={msg.sender || friend}
                      className="social-avatar social-avatar--sm"
                      size={32}
                    />
                  )}
                  <div className="gmsg__row">
                    <div className="gmsg__bubble">
                      <div className="gmsg__meta">
                        <strong>{senderName}</strong>
                        <time className="gmsg__time muted">{formatTime(msg.createdAt)}</time>
                      </div>

                      <ChatReplyQuote
                        replyTo={msg.replyTo}
                        currentUserId={currentUser?.id}
                        onJump={jumpToMessage}
                      />

                      {msg.type === 'image' && msg.media?.url && (
                        <button
                          type="button"
                          className="gmsg__image-btn"
                          onClick={() => setLightboxUrl(msg.media.url)}
                          aria-label="Perbesar foto"
                        >
                          <img
                            src={msg.media.url}
                            alt={msg.text || 'Foto di chat private'}
                            loading="lazy"
                            width={msg.media.width || undefined}
                            height={msg.media.height || undefined}
                            className="gmsg__image"
                            onError={handleMediaError}
                          />
                        </button>
                      )}

                      {msg.type === 'audio' && (msg.media?.url || msg.media?.streamUrl) && (
                        <VoiceNotePlayer
                          msg={msg}
                          token={social.actions.getToken?.()}
                          onExpiredUrl={handleMediaError}
                        />
                      )}

                      {msg.text && <p className="gmsg__text">{msg.text}</p>}
                    </div>

                    <ChatReplyButton
                      senderName={senderName}
                      onClick={() => {
                        sound.playClick();
                        startReply(msg, friend.name);
                      }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {error && (
          <p className="alert alert--error group-chat__error" role="alert">
            {error}
          </p>
        )}

        {uploadingMedia && (
          <p className="group-chat__uploading muted" role="status">
            <span className="spinner" aria-hidden="true" /> Mengompres & mengunggah media...
          </p>
        )}

        <ChatReplyBanner
          replyTarget={replyTarget}
          currentUserId={currentUser?.id}
          onCancel={clearReply}
        />

        {recording ? (
          <div className="group-chat__recorder" role="region" aria-label="Perekam pesan suara">
            <span className="recorder-indicator" aria-hidden="true" />
            <span className="recorder-timer">
              <span className="recorder-timer__label">Merekam suara:</span>{' '}
              <span className="recorder-timer__time">
                <strong>{formatDuration(recordElapsedMs)}</strong> / {formatDuration(MAX_VOICE_DURATION_MS)}
              </span>
            </span>
            <div className="recorder-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onCancelVoice}>
                Batal
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={sendRecordedVoice}>
                <Icon name="send" size={16} />
                <span>Kirim suara</span>
              </button>
            </div>
          </div>
        ) : (
          <form className="group-chat__composer" onSubmit={onSendText}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={onSelectPhoto}
              tabIndex={-1}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Kirim foto"
              title={
                social.mediaEnabled
                  ? 'Kirim foto (otomatis dikompres WebP)'
                  : 'Fitur media belum diaktifkan di server'
              }
              disabled={!social.mediaEnabled || uploadingMedia || sending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="camera" size={20} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Rekam pesan suara"
              title={
                social.mediaEnabled
                  ? 'Rekam pesan suara (maks 2 menit)'
                  : 'Fitur media belum diaktifkan di server'
              }
              disabled={!social.mediaEnabled || uploadingMedia || sending}
              onClick={onStartVoice}
            >
              <Icon name="mic" size={20} />
            </button>
            <label htmlFor="dm-chat-input" className="sr-only">
              Tulis pesan private
            </label>
            <input
              ref={inputRef}
              id="dm-chat-input"
              type="text"
              className="input"
              placeholder={`Tulis pesan ke ${friend.name}...`}
              maxLength={1000}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && replyTarget) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.nativeEvent.stopPropagation();
                  clearReply();
                }
              }}
              disabled={sending}
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={sending || !text.trim()}
            >
              Kirim
            </button>
          </form>
        )}

        {lightboxUrl && (
          <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Pratinjau foto"
            onClick={() => setLightboxUrl('')}
          >
            <button
              type="button"
              className="icon-btn lightbox__close"
              aria-label="Tutup foto"
              onClick={() => setLightboxUrl('')}
            >
              <Icon name="close" size={18} />
            </button>
            <img
              src={lightboxUrl}
              alt="Foto ukuran penuh"
              className="lightbox__img"
              onClick={e => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function FriendsModal({
  isOpen,
  onClose,
  asPage = false,
  currentUser,
  social,
  initialChatFriendId = '',
  onViewProfile,
  onOpenAuth
}) {
  const [username, setUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState('');
  const [activeFriendId, setActiveFriendId] = useState(initialChatFriendId || '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  useBackHandler(isOpen && !!activeFriendId, () => setActiveFriendId(''));

  const avatarInputRef = useRef(null);

  const { friends, incoming, outgoing, friendsLoading, unreadDmByFriend = {}, actions } = social;

  useEffect(() => {
    if (isOpen) {
      setFeedback(null);
      setConfirmRemoveId('');
      // Muat ulang daftar teman & permintaan saat dibuka, jaga-jaga event socket sempat terlewat
      if (currentUser) actions.reloadFriends?.();
      if (initialChatFriendId) {
        setActiveFriendId(initialChatFriendId);
      }
    } else {
      setActiveFriendId('');
    }
  }, [isOpen, initialChatFriendId]);

  const activeFriend = friends.find(f => f.userId === activeFriendId) || null;

  const onSelectProfileAvatar = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploadingAvatar) return;
    sound.playClick();
    setUploadingAvatar(true);
    setFeedback(null);
    try {
      const updated = await actions.uploadAvatar(file);
      if (!updated) return;
      sound.playWin();
      setFeedback({
        type: 'success',
        text: 'Foto profil berhasil dikompres dan disimpan ke MinIO S3!'
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const onAddFriend = async e => {
    e.preventDefault();
    const clean = username.trim().replace(/^@/, '');
    if (!clean || submitting) return;
    sound.playClick();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await actions.sendFriendRequest(clean);
      setUsername('');
      if (res.status === 'accepted') {
        sound.playWin();
        setFeedback({
          type: 'success',
          text: `Sekarang kamu berteman dengan ${res.user?.name || `@${clean}`}!`
        });
      } else {
        setFeedback({
          type: 'success',
          text: `Permintaan pertemanan dikirim ke @${res.user?.username || clean}.`
        });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAccept = async user => {
    sound.playClick();
    setBusyId(user.userId);
    setFeedback(null);
    try {
      await actions.acceptFriendRequest(user.userId);
      sound.playJoinNotification();
      setFeedback({ type: 'success', text: `${user.name} ditambahkan ke daftar teman.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusyId('');
    }
  };

  const handleRemove = async (user, label) => {
    sound.playClick();
    setBusyId(user.userId);
    setFeedback(null);
    try {
      await actions.removeFriend(user.userId);
      setConfirmRemoveId('');
      if (label) setFeedback({ type: 'success', text: label });
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusyId('');
    }
  };

  const onlineCount = friends.filter(f => f.online).length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      asPage={asPage}
      size={activeFriend ? 'lg' : 'md'}
      className={activeFriend ? 'friends-modal--chat' : ''}
      icon="👥"
      title={activeFriend ? `Chat · ${activeFriend.name}` : 'Teman & Chat Private'}
      // Saat chat terbuka, nama & @username sudah ada di kepala obrolan, jadi subtitle tidak diulang
      subtitle={
        !currentUser
          ? 'Masuk akun untuk menambah teman dan berkirim pesan private.'
          : activeFriend
          ? undefined
          : `${friends.length} teman · ${onlineCount} sedang online`
      }
    >
      {!currentUser ? (
        <div className="state-msg">
          <p>Masuk atau daftar akun PlayGo dulu untuk memakai fitur pertemanan dan chat private.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              sound.playClick();
              onClose();
              onOpenAuth?.();
            }}
          >
            Masuk atau daftar
          </button>
        </div>
      ) : activeFriend ? (
        <DirectChatView
          friend={activeFriend}
          currentUser={currentUser}
          social={social}
          onBack={() => setActiveFriendId('')}
          onViewProfile={onViewProfile}
        />
      ) : (
        <div className="social-stack">
          <section className="social-profile-bar card" aria-label="Profil kamu">
            <div className="social-profile-bar__info">
              <UserAvatar user={currentUser} className="social-avatar social-avatar--lg" size={44} />
              <div className="social-row__info">
                <strong>
                  {onViewProfile ? (
                    <button
                      type="button"
                      className="user-link"
                      onClick={() => {
                        sound.playClick();
                        onViewProfile(currentUser.id);
                      }}
                    >
                      {currentUser.name}
                    </button>
                  ) : (
                    currentUser.name
                  )}
                </strong>
                <span className="muted">@{currentUser.username} · Klik nama untuk lihat profil</span>
              </div>
            </div>
            <div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={onSelectProfileAvatar}
                tabIndex={-1}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={uploadingAvatar}
                onClick={() => avatarInputRef.current?.click()}
              >
                <Icon name="camera" size={15} />
                <span>{uploadingAvatar ? 'Mengunggah...' : 'Ubah foto profil'}</span>
              </button>
            </div>
          </section>

          <form className="social-inline-form" onSubmit={onAddFriend}>
            <label htmlFor="friend-username-input" className="sr-only">
              Username teman
            </label>
            <input
              id="friend-username-input"
              type="text"
              className="input"
              placeholder="Tambah teman pakai @username..."
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCapitalize="none"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || !username.trim()}
            >
              {submitting ? 'Mengirim...' : 'Tambah'}
            </button>
          </form>

          {feedback && (
            <p
              className={`alert alert--${feedback.type === 'success' ? 'success' : 'error'}`}
              role={feedback.type === 'success' ? 'status' : 'alert'}
            >
              {feedback.text}
            </p>
          )}

          {incoming.length > 0 && (
            <section className="social-section" aria-labelledby="incoming-friends-title">
              <div className="section-head">
                <h3 id="incoming-friends-title" className="panel-section__title">
                  Permintaan masuk
                </h3>
                <span className="badge badge--brand">{incoming.length}</span>
              </div>
              <ul className="social-list">
                {incoming.map(u => (
                  <li key={u.userId} className="social-row">
                    <UserAvatar user={u} />
                    <div className="social-row__info">
                      <strong>
                        {onViewProfile ? (
                          <button
                            type="button"
                            className="user-link"
                            onClick={() => {
                              sound.playClick();
                              onViewProfile(u.userId);
                            }}
                          >
                            {u.name}
                          </button>
                        ) : (
                          u.name
                        )}
                      </strong>
                      <span className="muted">@{u.username}</span>
                    </div>
                    <div className="social-row__actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={busyId === u.userId}
                        onClick={() => handleAccept(u)}
                      >
                        Terima
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyId === u.userId}
                        onClick={() => handleRemove(u, `Permintaan dari @${u.username} ditolak.`)}
                      >
                        Tolak
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {outgoing.length > 0 && (
            <section className="social-section" aria-labelledby="outgoing-friends-title">
              <div className="section-head">
                <h3 id="outgoing-friends-title" className="panel-section__title">
                  Permintaan terkirim
                </h3>
                <span className="badge">{outgoing.length}</span>
              </div>
              <ul className="social-list">
                {outgoing.map(u => (
                  <li key={u.userId} className="social-row">
                    <UserAvatar user={u} />
                    <div className="social-row__info">
                      <strong>
                        {onViewProfile ? (
                          <button
                            type="button"
                            className="user-link"
                            onClick={() => {
                              sound.playClick();
                              onViewProfile(u.userId);
                            }}
                          >
                            {u.name}
                          </button>
                        ) : (
                          u.name
                        )}
                      </strong>
                      <span className="muted">@{u.username} · Menunggu konfirmasi</span>
                    </div>
                    <div className="social-row__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyId === u.userId}
                        onClick={() => handleRemove(u, `Permintaan ke @${u.username} dibatalkan.`)}
                      >
                        Batalkan
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="social-section" aria-labelledby="friends-list-title">
            <div className="section-head">
              <h3 id="friends-list-title" className="panel-section__title">
                Daftar teman
              </h3>
              <span className="badge">{friends.length}</span>
            </div>

            {friendsLoading && friends.length === 0 ? (
              <p className="state-msg" role="status">
                <span className="spinner" aria-hidden="true" /> Memuat daftar teman...
              </p>
            ) : friends.length === 0 ? (
              <p className="social-empty muted">
                Belum ada teman. Masukkan username temanmu di atas untuk mulai bermain & mengobrol bareng!
              </p>
            ) : (
              <ul className="social-list">
                {friends.map(u => {
                  const unreadCount = unreadDmByFriend[u.userId] || 0;
                  const lastPreview = previewDirectMessage(u.lastMessage, currentUser.id);
                  return (
                    <li key={u.userId} className="social-row">
                      <div className="social-avatar-wrap">
                        <UserAvatar user={u} />
                        <span
                          className={`status-dot ${u.online ? 'status-dot--online' : 'status-dot--offline'}`}
                          title={u.online ? 'Online' : 'Offline'}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="social-row__info">
                        <strong>
                          {onViewProfile ? (
                            <button
                              type="button"
                              className="user-link"
                              onClick={() => {
                                sound.playClick();
                                onViewProfile(u.userId);
                              }}
                            >
                              {u.name}
                            </button>
                          ) : (
                            u.name
                          )}
                        </strong>
                        <span className="muted">
                          @{u.username} ·{' '}
                          <span className={u.online ? 'text-online' : ''}>
                            {u.online ? 'Online' : 'Offline'}
                          </span>
                        </span>
                        {lastPreview && (
                          <span className="dm-row-preview muted">{lastPreview}</span>
                        )}
                      </div>
                      <div className="social-row__actions">
                        {confirmRemoveId === u.userId ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--danger btn--sm"
                              disabled={busyId === u.userId}
                              onClick={() => handleRemove(u, `${u.name} dihapus dari daftar teman.`)}
                            >
                              Ya, hapus
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busyId === u.userId}
                              onClick={() => setConfirmRemoveId('')}
                            >
                              Batal
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={() => {
                                sound.playClick();
                                setActiveFriendId(u.userId);
                              }}
                            >
                              <Icon name="chat" size={15} />
                              <span>Chat</span>
                              {unreadCount > 0 && (
                                <span className="badge badge--warning">{unreadCount}</span>
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busyId === u.userId}
                              onClick={() => setConfirmRemoveId(u.userId)}
                            >
                              Hapus
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
