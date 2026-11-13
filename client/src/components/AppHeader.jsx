import React, { useEffect, useRef, useState } from 'react';
import ThemeToggle from './ThemeToggle';
import Icon from './Icon';
import { NetworkIndicator } from './NetworkStatus';
import { isAvatarUrl } from '../social/media';
import { sound } from '../sound';
import playgoLogo from '../assets/playgo-logo-sm.webp';

function soundIconName(audio) {
  if (audio.bgmMuted && audio.sfxMuted) return 'volume-off';
  return 'volume-on';
}

// Menu akun: profil, ubah avatar, poin, teman, grup, peringkat, dan keluar akun
function AccountMenu({
  user,
  friendBadgeCount = 0,
  groupBadgeCount = 0,
  onOpenFriends,
  onOpenGroups,
  onOpenLeaderboard,
  onViewProfile,
  onUploadAvatar,
  onLogout
}) {
  const [open, setOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarFeedback, setAvatarFeedback] = useState(null);
  const ref = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = e => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = e => {
      if (e.key === 'Escape') {
        setOpen(false);
        ref.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = fn => () => {
    setOpen(false);
    fn?.();
  };

  const handleSelectAvatar = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploadingAvatar || !onUploadAvatar) return;
    sound.playClick();
    setUploadingAvatar(true);
    setAvatarFeedback(null);
    try {
      const updated = await onUploadAvatar(file);
      if (!updated) return;
      sound.playWin();
      setAvatarFeedback({ type: 'success', text: 'Foto profil diperbarui!' });
    } catch (err) {
      setAvatarFeedback({ type: 'error', text: err.message });
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="account__trigger"
        data-tour="account"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Akun ${user.name}`}
        onClick={() => {
          setAvatarFeedback(null);
          setOpen(v => !v);
        }}
      >
        {isAvatarUrl(user.avatar) ? (
          <img src={user.avatar} alt="" width="28" height="28" className="account__avatar account__avatar--img" />
        ) : (
          <span className="account__avatar" aria-hidden="true">
            {user.name?.slice(0, 1).toUpperCase() || <Icon name="pawn" size={16} />}
          </span>
        )}
        <span className="account__name">{user.name}</span>
      </button>
      {open && (
        <div className="account__menu card">
          <div className="account__profile">
            <div className="account__profile-top">
              {isAvatarUrl(user.avatar) ? (
                <img src={user.avatar} alt="" width="48" height="48" className="social-avatar social-avatar--lg" />
              ) : (
                <span className="social-avatar social-avatar--lg" aria-hidden="true">
                  {user.name?.slice(0, 1).toUpperCase() || <Icon name="pawn" size={20} />}
                </span>
              )}
              <div className="account__profile-info">
                <strong>
                  {user.name} {user.isLudoKing && <Icon name="crown" size={16} label="Ludo King" />}
                </strong>
                <span className="muted">@{user.username}</span>
                <span className="badge badge--brand">
                  <Icon name="coin" size={14} /> {user.points ?? 0} Coins
                </span>
              </div>
            </div>
            {onUploadAvatar && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleSelectAvatar}
                  tabIndex={-1}
                />
                <button
                  type="button"
                  className="btn btn--secondary btn--sm btn--block"
                  disabled={uploadingAvatar}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="camera" size={15} />
                  <span>{uploadingAvatar ? 'Mengunggah foto...' : 'Ubah foto profil'}</span>
                </button>
              </>
            )}
            {avatarFeedback && (
              <p
                className={`alert alert--${avatarFeedback.type === 'success' ? 'success' : 'error'}`}
                role={avatarFeedback.type === 'success' ? 'status' : 'alert'}
              >
                {avatarFeedback.text}
              </p>
            )}
          </div>
          {onViewProfile && (
            <button
              type="button"
              className="account__item"
              onClick={pick(() => onViewProfile(user.id))}
            >
              <span className="account__item-label">
                <Icon name="pawn" size={17} /> Profil saya
              </span>
            </button>
          )}
          {onOpenFriends && (
            <button type="button" className="account__item" onClick={pick(onOpenFriends)}>
              <span className="account__item-label">
                <Icon name="friends" size={17} /> Teman
              </span>
              {friendBadgeCount > 0 && <span className="badge badge--brand">{friendBadgeCount}</span>}
            </button>
          )}
          {onOpenGroups && (
            <button type="button" className="account__item" onClick={pick(onOpenGroups)}>
              <span className="account__item-label">
                <Icon name="chat" size={17} /> Grup & Chat
              </span>
              {groupBadgeCount > 0 && <span className="badge badge--brand">{groupBadgeCount}</span>}
            </button>
          )}
          <button type="button" className="account__item" data-tour="leaderboard" onClick={pick(onOpenLeaderboard)}>
            <span className="account__item-label">
              <Icon name="trophy" size={17} /> Peringkat pemain
            </span>
          </button>
          <button type="button" className="account__item account__item--danger" onClick={pick(onLogout)}>
            <span className="account__item-label">
              <Icon name="logout" size={17} /> Keluar akun
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// Header beranda & lobby. Di HP hanya ikon 44px agar tidak melebar keluar layar.
export default function AppHeader({
  user,
  audio,
  network,
  theme,
  friendBadgeCount = 0,
  groupBadgeCount = 0,
  onGoHome,
  onOpenFriends,
  onOpenGroups,
  onOpenShop,
  onOpenAudio,
  onOpenAuth,
  onOpenLeaderboard,
  onViewProfile,
  onUploadAvatar,
  onLogout
}) {
  return (
    <header className="app-header">
      <div
        className="brand"
        role={onGoHome ? 'button' : undefined}
        tabIndex={onGoHome ? 0 : undefined}
        onClick={onGoHome || undefined}
        onKeyDown={
          onGoHome
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onGoHome();
                }
              }
            : undefined
        }
        style={onGoHome ? { cursor: 'pointer' } : undefined}
      >
        <img src={playgoLogo} alt="" width="40" height="40" className="brand__logo" />
        <span className="brand__name">
          Play<span className="brand__accent">Go</span>
        </span>
      </div>

      <div className="app-header__actions">
        <NetworkIndicator {...network} />
        {user && (
          <span className="badge badge--brand app-header__points" title="Coins kamu">
            <Icon name="coin" size={14} /> {user.points ?? 0}
          </span>
        )}
        {onOpenFriends && (
          <button
            type="button"
            className="icon-btn app-header__nav-btn"
            data-tour="friends"
            aria-label={friendBadgeCount > 0 ? `Teman (${friendBadgeCount} permintaan baru)` : 'Teman'}
            title="Teman"
            onClick={() => {
              sound.playClick();
              onOpenFriends();
            }}
          >
            <Icon name="friends" size={20} />
            {friendBadgeCount > 0 && (
              <span className="count-badge" aria-hidden="true">
                {friendBadgeCount}
              </span>
            )}
          </button>
        )}
        {onOpenGroups && (
          <button
            type="button"
            className="icon-btn app-header__nav-btn"
            data-tour="groups"
            aria-label={groupBadgeCount > 0 ? `Grup & Chat (${groupBadgeCount} undangan baru)` : 'Grup & Chat'}
            title="Grup & Chat"
            onClick={() => {
              sound.playClick();
              onOpenGroups();
            }}
          >
            <Icon name="chat" size={20} />
            {groupBadgeCount > 0 && (
              <span className="count-badge" aria-hidden="true">
                {groupBadgeCount}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className="icon-btn app-header__nav-btn"
          aria-label="Toko item"
          title="Toko item"
          onClick={() => {
            sound.playClick();
            onOpenShop();
          }}
        >
          <Icon name="shop" size={20} />
        </button>
        <button type="button" className="icon-btn" aria-label="Pengaturan suara" title="Pengaturan suara" onClick={onOpenAudio}>
          <Icon name={soundIconName(audio)} size={20} />
        </button>
        <ThemeToggle theme={theme} />
        {user ? (
          <AccountMenu
            user={user}
            friendBadgeCount={friendBadgeCount}
            groupBadgeCount={groupBadgeCount}
            onOpenFriends={onOpenFriends}
            onOpenGroups={onOpenGroups}
            onOpenLeaderboard={onOpenLeaderboard}
            onViewProfile={onViewProfile}
            onUploadAvatar={onUploadAvatar}
            onLogout={onLogout}
          />
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            data-tour="account"
            onClick={() => {
              sound.playClick();
              onOpenAuth();
            }}
          >
            Masuk
          </button>
        )}
      </div>
    </header>
  );
}
