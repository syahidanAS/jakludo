import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import AppHeader from './components/AppHeader';
import MobileBottomNav from './components/MobileBottomNav';
import GameHeader from './components/game/GameHeader';
import Toasts from './components/Toasts';
import { ReconnectBar } from './components/NetworkStatus';
import InstallGuide from './components/InstallGuide';
import NotificationPrompt from './components/NotificationPrompt';
import SocialOnboardingTour from './components/SocialOnboardingTour';
import AvatarCropModal from './components/AvatarCropModal';
import HomeScreen from './screens/HomeScreen';
import LobbyScreen from './screens/LobbyScreen';
import GameScreen from './screens/GameScreen';
import MonsterQuizScreen from './screens/MonsterQuizScreen';
import ChessMasterScreen from './screens/ChessMasterScreen';
import AudioSettingsModal from './AudioSettingsModal';
import PlayerProfileModal from './social/PlayerProfileModal';
import { useAuth } from './hooks/useAuth';
import { useGameRoom } from './hooks/useGameRoom';
import { useSocial } from './hooks/useSocial';
import { useMonsterQuiz } from './hooks/useMonsterQuiz';
import { useChessMaster } from './hooks/useChessMaster';
import { useActiveRooms } from './hooks/useActiveRooms';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useTheme } from './hooks/useTheme';
import { usePwaInstall } from './hooks/usePwaInstall';
import { useItemCatalog } from './items';
import { sound } from './sound';
import { applySeo, gameModeUrl, getInitialGameModeFromUrl } from './seo';
import { runBackHandler } from './backHandlers';

// Dialog yang jarang dibuka dimuat terpisah agar bundle awal lebih kecil.
// Diunduh di belakang layar saat browser senggang, jadi tetap langsung muncul saat dibuka.
const loadAuth = () => import('./AuthModal');
const loadLeaderboard = () => import('./LeaderboardModal');
const loadShop = () => import('./ShopModal');
const loadFriends = () => import('./social/FriendsModal');
const loadGroups = () => import('./screens/GroupsScreen');
const AuthModal = lazy(loadAuth);
const LeaderboardModal = lazy(loadLeaderboard);
const ShopModal = lazy(loadShop);
const FriendsModal = lazy(loadFriends);
const GroupsScreen = lazy(loadGroups);

function preloadDialogs() {
  const run = () => [loadAuth, loadLeaderboard, loadShop, loadFriends, loadGroups].forEach(load => load().catch(() => {}));
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}

export default function App() {
  const [modal, setModal] = useState(null); // 'auth' | 'shop' | 'audio' | 'leaderboard' | 'friends' | 'groups' | null
  const [gameMode, setGameMode] = useState(getInitialGameModeFromUrl); // 'hub' | 'ludo' | 'quiz'
  const [profileUserId, setProfileUserId] = useState('');
  const [initialChatFriendId, setInitialChatFriendId] = useState('');
  const [cropRequest, setCropRequest] = useState(null);
  const [audio, setAudio] = useState(sound.getState());
  const [sheet, setSheet] = useState(null); // bottom sheet di layar permainan: 'chat' | 'scores'
  const [leaveRequest, setLeaveRequest] = useState(0); // Back saat bermain Ludo membuka konfirmasi keluar
  const [isMobileView, setIsMobileView] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : false
  );
  // Riwayat navigasi: pindah game dan membuka halaman/dialog menambah entri history, jadi tombol Back
  // (browser/HP) kembali ke layar sebelumnya, bukan keluar dari situs. Tiap entri menyimpan entri
  // sebelumnya (back) supaya tombol "kembali" di aplikasi memakai history.back() bila tujuannya sama.
  const navCur = useRef({ mode: gameMode, modal: null });
  const expectingPop = useRef(false);
  const roomRef = useRef({});
  useEffect(() => {
    navCur.current = { mode: gameMode, modal };
  }, [gameMode, modal]);

  const navigateTo = useCallback(({ mode = navCur.current.mode, modal: nextModal = null }) => {
    const cur = navCur.current;
    if (cur.mode === mode && cur.modal === nextModal) return;
    navCur.current = { mode, modal: nextModal };
    setGameMode(mode);
    setModal(nextModal);
    const st = window.history.state?.playgo ? window.history.state : null;
    const back = st?.back;
    if (back && back.mode === mode && (back.modal || null) === nextModal) {
      expectingPop.current = true;
      window.history.back();
      return;
    }
    // Selama di room URL ?room= dipertahankan; dialog tidak menambah entri di atas dialog lain
    const url = roomRef.current.inRoom ? window.location.pathname + window.location.search : gameModeUrl(mode);
    const entry = { playgo: true, mode, modal: nextModal, back: cur.modal ? back || null : cur };
    if (cur.modal) window.history.replaceState(entry, '', url);
    else window.history.pushState(entry, '', url);
  }, []);

  const auth = useAuth();
  const requestAvatarCrop = useCallback(({ file, title, subtitle }) => {
    if (!file || !String(file.type || '').startsWith('image/')) {
      return Promise.reject(new Error('Pilih file gambar yang valid.'));
    }
    return new Promise(resolve => {
      setCropRequest({ file, title, subtitle, resolve });
    });
  }, []);
  const game = useGameRoom({
    authToken: auth.authToken,
    currentUser: auth.currentUser,
    onNeedLogin: () => navigateTo({ modal: 'auth' })
  });
  const quiz = useMonsterQuiz({
    socket: game.socket,
    authToken: auth.authToken,
    currentUser: auth.currentUser,
    onUpdateUser: auth.setCurrentUser,
    onNeedLogin: () => navigateTo({ modal: 'auth' }),
    active: gameMode === 'quiz'
  });
  const chess = useChessMaster({
    socket: game.socket,
    authToken: auth.authToken,
    currentUser: auth.currentUser,
    onUpdateUser: auth.setCurrentUser,
    onNeedLogin: () => navigateTo({ modal: 'auth' }),
    active: gameMode === 'chess'
  });
  const social = useSocial({
    socket: game.socket,
    authToken: auth.authToken,
    currentUser: auth.currentUser,
    onUpdateUser: auth.setCurrentUser,
    onCropAvatar: requestAvatarCrop
  });
  const network = useNetworkStatus(game.socket);
  const theme = useTheme();
  const pwa = usePwaInstall({ onBeforePrompt: () => sound.playClick() });
  const activeRooms = useActiveRooms({
    enabled: game.screen === 'home' && (gameMode === 'hub' || gameMode === 'ludo'),
    authToken: auth.authToken
  });
  const itemCatalog = useItemCatalog();

  useEffect(() => sound.subscribe(state => setAudio({ ...state })), []);
  useEffect(preloadDialogs, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = e => setIsMobileView(e.matches);
    setIsMobileView(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  useEffect(() => {
    if (quiz.room?.code && game.screen === 'home') {
      setGameMode('quiz');
      if (window.history.state?.playgo) window.history.replaceState({ ...window.history.state, mode: 'quiz' }, '');
    }
  }, [quiz.room?.code, game.screen]);
  useEffect(() => {
    if (chess.room?.code && game.screen === 'home') {
      setGameMode('chess');
      if (window.history.state?.playgo) window.history.replaceState({ ...window.history.state, mode: 'chess' }, '');
    }
  }, [chess.room?.code, game.screen]);
  useEffect(() => {
    const activeMode = game.screen === 'room' ? 'ludo' : gameMode;
    const activeCode = game.room?.code || quiz.room?.code || chess.room?.code || null;
    applySeo({ gameMode: activeMode, modal, roomCode: activeCode });
  }, [gameMode, game.screen, game.room?.code, quiz.room?.code, chess.room?.code, modal]);

  useEffect(() => {
    const st = window.history.state?.playgo ? window.history.state : {};
    window.history.replaceState({ ...st, playgo: true, mode: navCur.current.mode, modal: null }, '');

    const apply = st => {
      navCur.current = { mode: st.mode || 'hub', modal: st.modal || null };
      setGameMode(st.mode || 'hub');
      setModal(st.modal || null);
      if (st.modal !== 'friends') setInitialChatFriendId('');
    };
    const onPopState = e => {
      const st = e.state?.playgo ? e.state : { mode: getInitialGameModeFromUrl(), modal: null };
      if (expectingPop.current) {
        expectingPop.current = false;
        apply(st);
        return;
      }
      const r = roomRef.current;
      const cur = navCur.current;
      // Back ditahan: kembalikan entri yang baru saja dilewati
      const restore = url =>
        window.history.pushState({ playgo: true, mode: cur.mode, modal: cur.modal, back: st }, '', url);
      if (r.profileOpen) {
        r.closeProfile();
        restore(r.currentUrl);
        return;
      }
      // Layar bertingkat di dalam halaman (chat teman, detail grup) kembali ke daftarnya dulu
      if (runBackHandler()) {
        restore(r.currentUrl);
        return;
      }
      if (cur.modal) {
        apply(st);
        return;
      }
      if (r.inGame || r.inQuizBattle || r.inChessBattle) {
        restore(r.currentUrl);
        if (r.inGame) setLeaveRequest(n => n + 1);
        return;
      }
      if (r.inLobby || r.inQuizRoom || r.inChessRoom) {
        // Back dari lobby = keluar room, tetap di halaman game yang sama
        if (r.inLobby) r.leaveLudo();
        else if (r.inQuizRoom) r.leaveQuiz();
        else r.leaveChess();
        restore(gameModeUrl(cur.mode));
        return;
      }
      apply(st);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Status chat terbuka dipakai untuk menghitung pesan belum dibaca
  const changeSheet = name => {
    setSheet(name);
    game.actions.setChatOpen(name === 'chat');
  };

  const open = name => () => {
    if (name === 'friends') setInitialChatFriendId('');
    navigateTo({ modal: name });
  };
  const close = () => {
    setInitialChatFriendId('');
    navigateTo({ modal: null });
  };
  const openProfile = userId => {
    if (!userId) return;
    setProfileUserId(String(userId));
  };
  const openChatWithFriend = friendId => {
    setProfileUserId('');
    setInitialChatFriendId(String(friendId || ''));
    navigateTo({ modal: 'friends' });
  };
  const openAudio = () => {
    sound.init();
    sound.playClick();
    navigateTo({ modal: 'audio' });
  };

  const inGame = game.screen === 'room' && game.room?.started;
  const inLobby = game.screen === 'room' && game.room && !game.room.started;
  const isMobileFeaturePage =
    isMobileView && !inGame && (modal === 'friends' || modal === 'groups' || modal === 'shop');
  const quizRoom = quiz.room;
  const chessRoom = chess.room;
  roomRef.current = {
    inRoom: game.screen === 'room',
    inGame,
    inLobby: game.screen === 'room' && !inGame,
    inQuizRoom: !!quizRoom,
    inQuizBattle: !!quizRoom && quizRoom.phase !== 'lobby' && quizRoom.phase !== 'finished',
    inChessRoom: !!chessRoom,
    inChessBattle: !!chessRoom && chessRoom.phase === 'playing',
    currentUrl: window.location.pathname + window.location.search,
    profileOpen: !!profileUserId,
    closeProfile: () => setProfileUserId(''),
    leaveLudo: game.actions.leaveRoom,
    leaveQuiz: quiz.actions.leaveRoom,
    leaveChess: chess.actions.leaveRoom
  };

  const showBottomNav =
    !inGame &&
    !(gameMode === 'quiz' && quiz.room && quiz.room.phase !== 'lobby') &&
    !(gameMode === 'chess' && chess.room && chess.room.phase !== 'lobby');

  return (
    <div className={`app ${inGame ? 'app--game' : ''} ${showBottomNav ? 'app--bottom-nav' : ''}`}>
      <a className="skip-link" href="#main">Langsung ke konten</a>
      <ReconnectBar {...network} />

      {inGame ? (
        <GameHeader
          room={game.room}
          audio={audio}
          network={network}
          onOpenShop={open('shop')}
          theme={theme}
          onOpenAudio={openAudio}
          onLeave={game.actions.leaveRoom}
          leaveRequest={leaveRequest}
        />
      ) : (
        <AppHeader
          user={auth.currentUser}
          audio={audio}
          network={network}
          friendBadgeCount={social.friendBadgeCount}
          groupBadgeCount={social.groupBadgeCount}
          onGoHome={
            isMobileFeaturePage
              ? () => {
                  sound.playClick();
                  close();
                }
              : game.screen === 'home' && !quiz.room
              ? () => {
                  sound.playClick();
                  navigateTo({ mode: 'hub' });
                }
              : undefined
          }
          onOpenFriends={open('friends')}
          onOpenGroups={open('groups')}
          onOpenShop={open('shop')}
          theme={theme}
          onOpenAudio={openAudio}
          onOpenAuth={open('auth')}
          onOpenLeaderboard={open('leaderboard')}
          onViewProfile={openProfile}
          onUploadAvatar={social.actions.uploadAvatar}
          onLogout={auth.logout}
        />
      )}

      <Toasts
        error={inGame ? game.error : ''}
        memberNotice={game.memberNotice}
        roomInvite={social.roomInvite}
        chatToast={game.chatToast || quiz.chatToast || chess.chatToast}
        reactions={game.reactions}
        onAcceptRoomInvite={(targetCode, inviteGameType) => {
          social.actions.dismissRoomInvite();
          if (inviteGameType === 'quiz') {
            navigateTo({ mode: 'quiz' });
            quiz.actions.joinRoomByCode(targetCode);
          } else if (inviteGameType === 'chess') {
            navigateTo({ mode: 'chess' });
            chess.actions.joinRoomByCode(targetCode);
          } else {
            navigateTo({ mode: 'ludo' });
            game.actions.joinRoom(targetCode);
          }
        }}
        onDismissRoomInvite={social.actions.dismissRoomInvite}
        onOpenChat={() => {
          if (game.chatToast) {
            game.actions.dismissChatToast();
            if (inGame) changeSheet('chat');
          } else if (quiz.chatToast) {
            quiz.actions.dismissChatToast();
            quiz.actions.setChatOpen(true);
          } else if (chess.chatToast) {
            chess.actions.dismissChatToast();
            chess.actions.setChatOpen(true);
          }
        }}
        onDismissChat={() => {
          game.actions.dismissChatToast();
          quiz.actions.dismissChatToast?.();
          chess.actions.dismissChatToast?.();
        }}
      />

      {inGame ? (
        <GameScreen game={game} itemCatalog={itemCatalog} sheet={sheet} onSheetChange={changeSheet} onOpenShop={open('shop')} />
      ) : isMobileFeaturePage ? (
        <Suspense
          fallback={
            <main className="loading-screen" id="main" role="status">
              <span className="spinner" aria-hidden="true" /> Memuat halaman...
            </main>
          }
        >
          {modal === 'shop' && (
            <ShopModal
              isOpen
              asPage
              onClose={close}
              currentUser={auth.currentUser}
              onUpdateUser={auth.setCurrentUser}
              authToken={auth.authToken}
              initialGame={gameMode === 'quiz' ? 'quiz' : 'all'}
            />
          )}
          {modal === 'friends' && (
            <FriendsModal
              isOpen
              asPage
              onClose={close}
              currentUser={auth.currentUser}
              social={social}
              initialChatFriendId={initialChatFriendId}
              onViewProfile={openProfile}
              onOpenAuth={open('auth')}
            />
          )}
          {modal === 'groups' && (
            <GroupsScreen
              isOpen
              asPage
              onClose={close}
              currentUser={auth.currentUser}
              social={social}
              gameActions={game.actions}
              quizActions={quiz.actions}
              onSelectGameMode={mode => navigateTo({ mode })}
              onViewProfile={openProfile}
              onOpenAuth={open('auth')}
            />
          )}
        </Suspense>
      ) : inLobby ? (
        <LobbyScreen
          room={game.room}
          me={game.me}
          playerId={game.playerId}
          currentUser={auth.currentUser}
          error={game.error}
          actions={game.actions}
          social={social}
          onOpenFriends={open('friends')}
          onViewProfile={openProfile}
        />
      ) : game.screen === 'room' ? (
        <main className="loading-screen" id="main" role="status">
          <span className="spinner" aria-hidden="true" /> Masuk ke room...
        </main>
      ) : gameMode === 'quiz' ? (
        <MonsterQuizScreen
          quiz={quiz}
          currentUser={auth.currentUser}
          onBackToMenu={() => {
            sound.playClick();
            navigateTo({ mode: 'hub' });
          }}
          onOpenAuth={open('auth')}
          onOpenShop={open('shop')}
          onOpenAudio={openAudio}
          onViewProfile={openProfile}
        />
      ) : gameMode === 'chess' ? (
        <ChessMasterScreen
          chess={chess}
          currentUser={auth.currentUser}
          onBackToMenu={() => {
            sound.playClick();
            navigateTo({ mode: 'hub' });
          }}
          onOpenAuth={open('auth')}
          onOpenShop={open('shop')}
          onOpenAudio={openAudio}
          onViewProfile={openProfile}
        />
      ) : (
        <HomeScreen
          user={auth.currentUser}
          checkingAuth={auth.checking}
          gameMode={gameMode}
          code={game.code}
          error={game.error}
          activeRooms={activeRooms}
          activeQuizRoom={quiz.room}
          activeChessRoom={chess.room}
          isInstalled={pwa.isInstalled}
          actions={game.actions}
          friendBadgeCount={social.friendBadgeCount}
          groupBadgeCount={social.groupBadgeCount}
          onSelectGame={mode => {
            sound.playClick();
            navigateTo({ mode });
          }}
          onBackToHub={() => {
            sound.playClick();
            navigateTo({ mode: 'hub' });
          }}
          onOpenFriends={open('friends')}
          onOpenGroups={open('groups')}
          onOpenAuth={open('auth')}
          onOpenLeaderboard={open('leaderboard')}
          onOpenMonsterQuiz={() => {
            sound.playClick();
            navigateTo({ mode: 'quiz' });
          }}
          onInstall={pwa.install}
        />
      )}

      {!inGame && !isMobileFeaturePage && (
        <footer className="app-footer">
          <span>© 2026 PlayGo</span>
          <span>Platform game multiplayer realtime bareng teman</span>
        </footer>
      )}

      {showBottomNav && (
        <MobileBottomNav
          activeModal={modal}
          friendBadgeCount={social.friendBadgeCount}
          groupBadgeCount={social.groupBadgeCount}
          onSelectHome={() => {
            setInitialChatFriendId('');
            navigateTo(game.screen === 'home' && !quiz.room ? { mode: 'hub' } : { modal: null });
          }}
          onOpenFriends={open('friends')}
          onOpenGroups={open('groups')}
          onOpenShop={open('shop')}
        />
      )}

      <Suspense fallback={null}>
        {modal === 'auth' && (
          <AuthModal
            isOpen
            onClose={close}
            onLoginSuccess={(user, token) => {
              auth.loginSuccess(user, token);
              close();
            }}
          />
        )}
        {modal === 'leaderboard' && (
          <LeaderboardModal
            isOpen
            onClose={close}
            currentUser={auth.currentUser}
            socket={game.socket}
            onViewProfile={openProfile}
            initialTab={gameMode === 'quiz' ? 'quiz' : gameMode === 'chess' ? 'chess' : 'ludo'}
          />
        )}
        {!isMobileFeaturePage && modal === 'shop' && (
          <ShopModal
            isOpen
            onClose={close}
            currentUser={auth.currentUser}
            onUpdateUser={auth.setCurrentUser}
            authToken={auth.authToken}
            initialGame={gameMode === 'quiz' ? 'quiz' : 'all'}
          />
        )}
        {!isMobileFeaturePage && modal === 'friends' && (
          <FriendsModal
            isOpen
            onClose={close}
            currentUser={auth.currentUser}
            social={social}
            initialChatFriendId={initialChatFriendId}
            onViewProfile={openProfile}
            onOpenAuth={open('auth')}
          />
        )}
        {!isMobileFeaturePage && modal === 'groups' && (
          <GroupsScreen
            isOpen
            onClose={close}
            currentUser={auth.currentUser}
            social={social}
            gameActions={game.actions}
            quizActions={quiz.actions}
            onSelectGameMode={mode => navigateTo({ mode })}
            onViewProfile={openProfile}
            onOpenAuth={open('auth')}
          />
        )}
      </Suspense>
      <PlayerProfileModal
        userId={profileUserId}
        isOpen={!!profileUserId}
        onClose={() => setProfileUserId('')}
        currentUser={auth.currentUser}
        social={social}
        onUpdateProfile={auth.updateProfile}
        onOpenChatWithFriend={openChatWithFriend}
        onOpenAuth={open('auth')}
      />
      <AudioSettingsModal isOpen={modal === 'audio'} onClose={close} />
      <InstallGuide platform={pwa.installGuide} onClose={pwa.closeInstallGuide} />
      <NotificationPrompt enabled={game.screen === 'home' && !modal && !profileUserId && !cropRequest && !pwa.installGuide} />
      <SocialOnboardingTour enabled={game.screen === 'home' && !modal && !profileUserId && !cropRequest && !pwa.installGuide} />
      <AvatarCropModal
        file={cropRequest?.file || null}
        title={cropRequest?.title}
        subtitle={cropRequest?.subtitle}
        onCancel={() => {
          const req = cropRequest;
          setCropRequest(null);
          req?.resolve(null);
        }}
        onConfirm={croppedFile => {
          const req = cropRequest;
          setCropRequest(null);
          req?.resolve(croppedFile);
        }}
      />
    </div>
  );
}
