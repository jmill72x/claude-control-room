import { useState } from 'react';
import { agentColors, initialOf } from '../lib/orbit/page.js';

const KEY = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// An agent's picture from /avatars/<key>.png, or a neutral initial: for an
// owner the roster doesn't know, an item whose tag has no agent, a missing file
// or a server that doesn't serve avatars yet. Decorative: the name is always
// written beside it.
export function Avatar({ agent, fallback = '', size = 32, tone = 'day' }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (agent && agent.index >= 0 && KEY.test(agent.key) && !failed) {
    return <img className="o-avatar" style={style} src={`/avatars/${agent.key}.png`} alt="" onError={() => setFailed(true)} />;
  }
  const colors = agentColors(agent?.index ?? -1);
  return (
    <span className={`o-avatar o-initial o-initial-${tone}`} style={{ ...style, fontSize: Math.round(size * 0.42), '--agent': colors[tone] }} aria-hidden="true">
      {initialOf(agent?.name ?? fallback)}
    </span>
  );
}
