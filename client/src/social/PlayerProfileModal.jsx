import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../components/Modal';
import Icon from '../components/Icon';
import { isAvatarUrl } from './media';
import { storage } from '../storage';
import { sound } from '../sound';

function ProfileAvatar({ user, size = 76 }) {
  if (isAvatarUrl(user?.avatar)) {
    return (
      <img
        src={user.avatar}
        alt={`Foto profil ${user.name}`}
        width={size}
        height={size}
        className="profile-modal__avatar"
      />
    );
  }
  const initial = user?.name?.slice(0, 1).toUpperCase();
  return (
    <span className="profile-modal__avatar" aria-hidden="true">
      {initial || <Icon name="pawn" size={Math.round(size * 0.45)} />}
    </span>
  );
}

function GroupMiniAvatar({ group }) {
  if (isAvatarUrl(group?.avatar)) {
    return <img src={group.avatar} alt="" width="28" height="28" className="social-avatar social-avatar--sm" />;
  }
  return (
    <span className="social-avatar social-avatar--sm" aria-hidden="true">
      {group?.name?.slice(0, 1).toUpperCase() || 'G'}
    </span>
  );
}

function formatJoinDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return '';
  }
}

export default function PlayerProfileModal({
  userId,
  isOpen,
  onClose,
  currentUser,
  social,
  onOpenChatWithFriend,
  onOpenAuth,
  onUpdateProfile
}) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const avatarInputRef = useRef(null);

  // State Form Edit Profil
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!userId || !social?.actions?.getUserProfile) return;
    setLoading(true);
    setError('');
    try {
      const data = await social.actions.getUserProfile(userId);
      setProfile(data);
    } catch (err) {
      setError(err.message || 'Gagal memuat profil pemain.');
    } finally {
      setLoading(false);
    }
  }, [userId, social?.actions]);

  useEffect(() => {
    if (isOpen && userId) {
      setFeedback(null);
      setProfile(null);
      setIsEditing(false);
      setEditError('');
      loadProfile();
    }
  }, [isOpen, userId, loadProfile]);

  const startEditing = () => {
    setEditName(profile?.name || currentUser?.name || '');
    setEditUsername(profile?.username || currentUser?.username || '');
    setEditEmail(profile?.email || currentUser?.email || '');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowPasswordChange(false);
    setEditError('');
    setIsEditing(true);
    sound.playClick();
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditError('');
    sound.playClick();
  };

  const handleSaveProfile = async e => {
    e?.preventDefault();
    if (editSaving) return;

    const trimmedName = editName.trim();
    if (!trimmedName) {
      setEditError('Nama tampilan tidak boleh kosong.');
      return;
    }

    const trimmedUsername = editUsername.trim().toLowerCase();
    if (!trimmedUsername) {
      setEditError('Username wajib diisi.');
      return;
    }
    if (trimmedUsername.length < 3 || trimmedUsername.length > 20) {
      setEditError('Username harus 3–20 karakter.');
      return;
    }
    if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
      setEditError('Username hanya boleh berisi huruf kecil, angka, dan garis bawah (_).');
      return;
    }

    const trimmedEmail = editEmail.trim();
    if (trimmedEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        setEditError('Format email tidak valid.');
        return;
      }
    }

    if (showPasswordChange && (newPassword || currentPassword)) {
      if (profile?.hasPassword && !currentPassword) {
        setEditError('Password saat ini wajib diisi untuk mengganti password.');
        return;
      }
      if (!newPassword || newPassword.length < 8) {
        setEditError('Password baru minimal 8 karakter.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setEditError('Konfirmasi password baru tidak cocok.');
        return;
      }
    }

    setEditSaving(true);
    setEditError('');
    try {
      const payload = {
        name: trimmedName,
        username: trimmedUsername,
        email: trimmedEmail || null
      };
      if (showPasswordChange && newPassword) {
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }

      if (onUpdateProfile) {
        await onUpdateProfile(payload);
      } else {
        const token = storage.get('token');
        const res = await fetch('/api/auth/profile', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || 'Gagal memperbarui profil.');
        }
      }

      sound.playWin();
      setFeedback({ type: 'success', text: 'Profil berhasil diperbarui!' });
      setIsEditing(false);
      await loadProfile();
    } catch (err) {
      setEditError(err.message || 'Gagal menyimpan perubahan profil.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleAddFriend = async () => {
    if (!profile?.username || busy) return;
    if (!currentUser) {
      onClose();
      onOpenAuth?.();
      return;
    }
    sound.playClick();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await social.actions.sendFriendRequest(profile.username);
      if (res.status === 'accepted') {
        sound.playWin();
        setFeedback({ type: 'success', text: `Sekarang kamu berteman dengan ${profile.name}!` });
      } else {
        setFeedback({ type: 'success', text: `Permintaan pertemanan dikirim ke @${profile.username}.` });
      }
      await loadProfile();
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleAcceptFriend = async () => {
    if (!profile?.userId || busy) return;
    sound.playClick();
    setBusy(true);
    setFeedback(null);
    try {
      await social.actions.acceptFriendRequest(profile.userId);
      sound.playJoinNotification();
      setFeedback({ type: 'success', text: `${profile.name} ditambahkan ke daftar teman!` });
      await loadProfile();
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleUploadOwnAvatar = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy || !social?.actions?.uploadAvatar) return;
    sound.playClick();
    setBusy(true);
    setFeedback(null);
    try {
      const updated = await social.actions.uploadAvatar(file);
      if (!updated) return;
      sound.playWin();
      setFeedback({ type: 'success', text: 'Foto profil kamu berhasil diperbarui!' });
      await loadProfile();
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const isSelf = !!(profile?.isSelf || (currentUser && profile?.userId === currentUser.id));
  const friendship = profile?.friendshipStatus || 'none';
  const joinLabel = formatJoinDate(profile?.createdAt);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      icon="pawn"
      title={profile ? `Profil · ${profile.name}` : 'Profil Pemain'}
      subtitle={profile ? `@${profile.username}` : 'Memuat informasi pemain...'}
    >
      {loading && !profile ? (
        <p className="state-msg" role="status">
          <span className="spinner" aria-hidden="true" /> Memuat profil pemain...
        </p>
      ) : error ? (
        <div className="state-msg" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={loadProfile}>
            Coba lagi
          </button>
        </div>
      ) : profile ? (
        <div className="profile-modal">
          <div className="profile-modal__hero card">
            <div className="profile-modal__avatar-wrap">
              <ProfileAvatar user={profile} size={76} />
              <span
                className={`status-dot status-dot--lg ${
                  profile.online ? 'status-dot--online' : 'status-dot--offline'
                }`}
                title={profile.online ? 'Sedang online' : 'Offline'}
                aria-hidden="true"
              />
            </div>

            <div className="profile-modal__identity">
              <div className="profile-modal__name-row">
                <h3 className="profile-modal__name">{profile.name}</h3>
                {isSelf && <span className="badge">Kamu</span>}
                {profile.isLudoKing && (
                  <span className="badge badge--warning">
                    <Icon name="crown" size={14} /> Ludo King
                  </span>
                )}
              </div>
              <p className="muted">
                @{profile.username} ·{' '}
                <span className={profile.online ? 'text-online' : ''}>
                  {profile.online ? 'Sedang online' : 'Offline'}
                </span>
              </p>
              <div className="profile-modal__badges">
                {joinLabel && <span className="badge">Bergabung {joinLabel}</span>}
                {isSelf && profile.email && (
                  <span className="badge badge--brand" title="Email terdaftar">
                    <Icon name="mail" size={13} /> {profile.email}
                  </span>
                )}
                {isSelf && profile.authType === 'google' && (
                  <span className="badge badge--success" title="Terhubung dengan akun Google">
                    Google
                  </span>
                )}
                <span className="badge">
                  <Icon name="friends" size={13} /> {profile.friendCount ?? 0} teman
                </span>
                <span className="badge">
                  <Icon name="chat" size={13} /> {profile.groupCount ?? 0} grup
                </span>
              </div>
            </div>
          </div>

          {feedback && (
            <p
              className={`alert alert--${feedback.type === 'success' ? 'success' : 'error'}`}
              role={feedback.type === 'success' ? 'status' : 'alert'}
            >
              {feedback.text}
            </p>
          )}

          {isEditing && isSelf ? (
            <form className="profile-edit-section" onSubmit={handleSaveProfile} noValidate>
              <div className="profile-edit-section__header">
                <h4 className="profile-edit-section__title">
                  <Icon name="edit" size={18} />
                  <span>Edit Data Profil</span>
                </h4>
                <button
                  type="button"
                  className="icon-btn icon-btn--plain"
                  onClick={cancelEditing}
                  title="Tutup form edit"
                  aria-label="Tutup form edit"
                >
                  <Icon name="close" size={18} />
                </button>
              </div>

              <div className="field">
                <label htmlFor="edit-profile-name">Nama Tampilan</label>
                <input
                  id="edit-profile-name"
                  type="text"
                  className="input"
                  value={editName}
                  maxLength={30}
                  placeholder="Nama Lengkap atau Panggilan"
                  onChange={e => setEditName(e.target.value)}
                  disabled={editSaving}
                  required
                />
                <span className="field__hint">Nama yang tampil di papan permainan &amp; duel kuis (maks 30 karakter).</span>
              </div>

              <div className="field">
                <label htmlFor="edit-profile-username">Username</label>
                <div className="field__with-prefix">
                  <span className="field__prefix">@</span>
                  <input
                    id="edit-profile-username"
                    type="text"
                    className="input"
                    value={editUsername}
                    maxLength={20}
                    placeholder="username"
                    onChange={e => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    disabled={editSaving}
                    required
                  />
                </div>
                <span className="field__hint">3–20 karakter: huruf kecil, angka, dan underscore (_).</span>
              </div>

              <div className="field">
                <label htmlFor="edit-profile-email">Email</label>
                <input
                  id="edit-profile-email"
                  type="email"
                  className="input"
                  value={editEmail}
                  placeholder="contoh: nama@domain.com"
                  onChange={e => setEditEmail(e.target.value)}
                  disabled={editSaving}
                />
                <span className="field__hint">
                  {profile.authType === 'google'
                    ? 'Akun terhubung dengan Google. Email digunakan untuk login & sinkronisasi.'
                    : 'Digunakan untuk pemulihan akun & login alternatif.'}
                </span>
              </div>

              <div className="profile-password-box">
                <button
                  type="button"
                  className="profile-password-header"
                  onClick={() => setShowPasswordChange(v => !v)}
                  aria-expanded={showPasswordChange}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                    <Icon name="lock" size={16} />
                    <span>{profile.hasPassword ? 'Ubah Password Akun' : 'Buat Password Akun'}</span>
                  </span>
                  <span className="badge">{showPasswordChange ? 'Tutup' : 'Ganti Password'}</span>
                </button>

                {showPasswordChange && (
                  <div className="profile-edit-form" style={{ marginTop: 'var(--space-2)' }}>
                    {profile.hasPassword && (
                      <div className="field">
                        <label htmlFor="edit-current-password">Password Saat Ini</label>
                        <div className="field__with-action">
                          <input
                            id="edit-current-password"
                            type={showCurrentPass ? 'text' : 'password'}
                            className="input"
                            value={currentPassword}
                            placeholder="Ketik password saat ini"
                            onChange={e => setCurrentPassword(e.target.value)}
                            disabled={editSaving}
                          />
                          <button
                            type="button"
                            className="icon-btn icon-btn--plain"
                            aria-label={showCurrentPass ? 'Sembunyikan password' : 'Lihat password'}
                            onClick={() => setShowCurrentPass(v => !v)}
                          >
                            <Icon name={showCurrentPass ? 'eye-off' : 'eye'} size={16} />
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="field">
                      <label htmlFor="edit-new-password">Password Baru</label>
                      <div className="field__with-action">
                        <input
                          id="edit-new-password"
                          type={showNewPass ? 'text' : 'password'}
                          className="input"
                          value={newPassword}
                          placeholder="Minimal 8 karakter"
                          onChange={e => setNewPassword(e.target.value)}
                          disabled={editSaving}
                        />
                        <button
                          type="button"
                          className="icon-btn icon-btn--plain"
                          aria-label={showNewPass ? 'Sembunyikan password' : 'Lihat password'}
                          onClick={() => setShowNewPass(v => !v)}
                        >
                          <Icon name={showNewPass ? 'eye-off' : 'eye'} size={16} />
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label htmlFor="edit-confirm-password">Konfirmasi Password Baru</label>
                      <div className="field__with-action">
                        <input
                          id="edit-confirm-password"
                          type={showConfirmPass ? 'text' : 'password'}
                          className="input"
                          value={confirmPassword}
                          placeholder="Ketik ulang password baru"
                          onChange={e => setConfirmPassword(e.target.value)}
                          disabled={editSaving}
                        />
                        <button
                          type="button"
                          className="icon-btn icon-btn--plain"
                          aria-label={showConfirmPass ? 'Sembunyikan password' : 'Lihat password'}
                          onClick={() => setShowConfirmPass(v => !v)}
                        >
                          <Icon name={showConfirmPass ? 'eye-off' : 'eye'} size={16} />
                        </button>
                      </div>
                      {newPassword && confirmPassword && (
                        <span className={`field__hint ${newPassword === confirmPassword ? 'is-ok' : 'is-error'}`}>
                          {newPassword === confirmPassword ? '✓ Password cocok' : '✕ Password tidak cocok'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {editError && (
                <p className="alert alert--error" role="alert">
                  {editError}
                </p>
              )}

              <div className="profile-edit-actions">
                <button
                  type="submit"
                  className="btn btn--primary"
                  style={{ flex: '1 1 140px' }}
                  disabled={editSaving}
                >
                  <Icon name="check" size={16} />
                  <span>{editSaving ? 'Menyimpan...' : 'Simpan Perubahan'}</span>
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={editSaving}
                  onClick={cancelEditing}
                >
                  Batal
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="profile-stats" aria-label="Statistik permainan">
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Peringkat</span>
                  <strong className="profile-stat__value">
                    {profile.rank ? `#${profile.rank}` : '—'}
                  </strong>
                  <span className="profile-stat__sub muted">
                    {profile.isLudoKing ? '👑 Ludo King' : 'Global'}
                  </span>
                </div>
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Menang</span>
                  <strong className="profile-stat__value">{profile.wins ?? 0}</strong>
                  <span className="profile-stat__sub muted">
                    dari {profile.matchesPlayed ?? 0} main
                  </span>
                </div>
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Rasio Menang</span>
                  <strong className="profile-stat__value">{profile.winRate ?? 0}%</strong>
                  <span className="profile-stat__sub muted">Win rate</span>
                </div>
                <div className="profile-stat card">
                  <span className="profile-stat__label muted">Total Coins</span>
                  <strong className="profile-stat__value">
                    <Icon name="coin" size={16} /> {profile.points ?? 0}
                  </strong>
                  <span className="profile-stat__sub muted">Coins PlayGo</span>
                </div>
              </div>

              {Array.isArray(profile.sharedGroups) && profile.sharedGroups.length > 0 && !isSelf && (
                <section className="social-section" aria-label="Grup yang sama">
                  <h4 className="panel-section__title">
                    Satu grup denganmu ({profile.sharedGroups.length})
                  </h4>
                  <div className="profile-shared-groups">
                    {profile.sharedGroups.map(g => (
                      <span key={g.id} className="badge profile-shared-group">
                        <GroupMiniAvatar group={g} />
                        <span>{g.name}</span>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <div className="profile-modal__actions">
                {isSelf ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary btn--block"
                      onClick={startEditing}
                    >
                      <Icon name="edit" size={16} />
                      <span>Edit Profil (Nama, Username, Email, Password)</span>
                    </button>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handleUploadOwnAvatar}
                      tabIndex={-1}
                    />
                    <button
                      type="button"
                      className="btn btn--secondary btn--block"
                      disabled={busy}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <Icon name="camera" size={16} />
                      <span>{busy ? 'Mengunggah foto...' : 'Ubah foto profil'}</span>
                    </button>
                  </>
                ) : friendship === 'friends' ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={() => {
                      sound.playClick();
                      onOpenChatWithFriend?.(profile.userId);
                    }}
                  >
                    <Icon name="chat" size={16} />
                    <span>Kirim pesan private</span>
                  </button>
                ) : friendship === 'incoming_pending' ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    disabled={busy}
                    onClick={handleAcceptFriend}
                  >
                    <Icon name="user-plus" size={16} />
                    <span>{busy ? 'Memproses...' : 'Terima permintaan pertemanan'}</span>
                  </button>
                ) : friendship === 'outgoing_pending' ? (
                  <button type="button" className="btn btn--secondary btn--block" disabled>
                    <span>Permintaan pertemanan terkirim</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    disabled={busy}
                    onClick={handleAddFriend}
                  >
                    <Icon name="user-plus" size={16} />
                    <span>{busy ? 'Mengirim...' : 'Tambah teman'}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

