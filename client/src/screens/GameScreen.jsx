import React, { useMemo } from 'react';
import LudoBoard from '../LudoBoard';
import Modal from '../components/Modal';
import TurnPanel from '../components/game/TurnPanel';
import ChatPanel from '../components/game/ChatPanel';
import Scoreboard from '../components/game/Scoreboard';
import GameNotices from '../components/game/GameNotices';
import ShieldPrompt from '../components/game/ShieldPrompt';
import WinnerDialog from '../components/game/WinnerDialog';
import { InventoryChips, ActiveItemActions } from '../ItemControls';
import { sound } from '../sound';
import { evaluateOceanBlueHints } from '../utils/oceanBlueHints.mjs';

// Layar permainan. Satu set kontrol saja; posisinya diatur CSS grid:
//   HP & tablet : papan di atas, panel giliran tepat di bawahnya, chat lewat bottom sheet
//   desktop     : papan di kiri (muat satu layar), panel di kanan termasuk chat
// sheet ('chat' | 'scores' | null) dipegang App agar toast chat juga bisa membuka obrolan
export default function GameScreen({ game, itemCatalog, sheet, onSheetChange, onOpenShop }) {
  const { room, me, playerId, isTurn, canAct, currentTurnPlayer, movablePawns, actions } = game;
  const moveHints = useMemo(
    () => evaluateOceanBlueHints({
      room,
      playerId,
      movablePawns,
      isMyTurn: isTurn,
      targeting: !!game.itemTargeting
    }),
    [room, playerId, movablePawns, isTurn, game.itemTargeting]
  );
  const openSheet = name => {
    sound.playClick();
    onSheetChange(name);
  };
  const closeSheet = () => onSheetChange(null);

  return (
    <main className="game" id="main">
      <div className="game__board">
        <GameNotices itemNotice={game.itemNotice} onDismissItem={actions.dismissItemNotice} />
        <LudoBoard
          room={room}
          myPlayerId={playerId}
          isMyTurn={isTurn}
          movablePawns={movablePawns}
          moveHints={moveHints}
          onMovePawn={actions.movePawn}
          targeting={!!game.itemTargeting}
          onSelectTarget={actions.selectTarget}
        />
      </div>

      <div className="game__panel">
        <TurnPanel
          room={room}
          me={me}
          isTurn={isTurn}
          canAct={canAct}
          currentTurnPlayer={currentTurnPlayer}
          movablePawns={movablePawns}
          moveHints={moveHints}
          unreadChats={game.unreadChats}
          actions={actions}
          onOpenChat={() => openSheet('chat')}
          onOpenScores={() => openSheet('scores')}
        />

        <ActiveItemActions
          catalog={itemCatalog}
          player={me}
          enabled={canAct}
          targetingItemId={game.itemTargeting}
          onToggleTarget={actions.setItemTargeting}
          onUse={actions.useItem}
        />

        <section className="panel-section card" aria-labelledby="inventory-title">
          <div className="section-head">
            <h2 id="inventory-title">Item kamu</h2>
            <button type="button" className="btn btn--ghost" onClick={onOpenShop}>Buka toko</button>
          </div>
          <InventoryChips catalog={itemCatalog} player={me} />
        </section>

        <section className="panel-section card show-desktop" aria-labelledby="chat-title">
          <h2 id="chat-title" className="panel-section__title">Obrolan</h2>
          <ChatPanel chats={game.chats} playerId={playerId} onSend={actions.sendChat} />
        </section>
      </div>

      <Modal isOpen={sheet === 'chat'} onClose={closeSheet} variant="sheet" title="Obrolan room" icon="💬">
        <ChatPanel chats={game.chats} playerId={playerId} onSend={actions.sendChat} />
      </Modal>

      <Modal isOpen={sheet === 'scores'} onClose={closeSheet} variant="sheet" title="Skor & log permainan" icon="📊">
        <Scoreboard room={room} playerId={playerId} currentTurnPlayer={currentTurnPlayer} />
      </Modal>

      <WinnerDialog room={room} me={me} actions={actions} />
      <ShieldPrompt room={room} playerId={playerId} catalog={itemCatalog} onDecide={actions.decideShield} />
    </main>
  );
}
