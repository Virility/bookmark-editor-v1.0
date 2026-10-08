const HEAT_BOOM_MS = 1600;
const HEAT_FIRE_IN_MS = 250;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function heatClickPoint(card, event) {
    if (!card || !event || event.clientX == null) return null;
    const box = card.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
        x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
        y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100))
    };
}

function boomPieces() {
    const rays = Array.from({ length: 12 }, (_, i) => `<b class="boom-ray" style="--a:${i * 30}deg"></b>`).join('');
    const clouds = Array.from({ length: 8 }, (_, i) => `<b class="boom-cloud" style="--a:${i * 45}deg"></b>`).join('');
    const chunks = Array.from({ length: 8 }, (_, i) => `<b class="boom-chunk" style="--a:${i * 45 + 18}deg"></b>`).join('');
    return `<b class="boom-spark"></b><b class="boom-core"></b>${rays}<b class="boom-ball"></b>${clouds}${chunks}`;
}

function boomMarkup() {
    const flames = [12, 38, 64, 86].map((x, i) => `<b class="boom-flame" style="--x:${x}%;--d:${(i * 0.11).toFixed(2)}s"></b>`).join('');
    return `${flames}${boomPieces()}`;
}

function boomGroup(x, y, kind, pieces, size, z, speed, delay, corner) {
    const paced = speed && speed !== 1 ? ' own-speed' : '';
    const wait = delay == null ? 500 : delay;
    const mark = corner == null ? '' : ` data-corner="${corner}"`;
    return `<span class="boom boom-${kind}${paced}"${mark} style="--bx:${x}%;--by:${y}%;--piece-size:${size || 1};z-index:${z || 1};--play:${speed || 1};--corner-delay:${wait}ms">${pieces || boomPieces()}</span>`;
}

function rev3Pieces() {
    return '<b class="rev3-spark"></b><b class="rev3-spark2"></b><b class="rev3-core"></b><b class="rev3-ring"></b><b class="rev3-bits"></b><b class="rev3-bits-in"></b>';
}

function liveFire(card) {
    return card ? card.querySelector(':scope > .heat-fire') : null;
}

function mountHeatFire(card, html) {
    let fire = liveFire(card);
    if (!fire) {
        fire = document.createElement('div');
        fire.className = 'heat-fire';
        fire.setAttribute('aria-hidden', 'true');
        card.appendChild(fire);
    }
    fire.innerHTML = html;
    return fire;
}

function placeHeatmapFire(card, at) {
    const fire = liveFire(card);
    if (!fire || !at) return;
    fire.style.setProperty('--mx', `${at.x}%`);
    fire.style.setProperty('--my', `${at.y}%`);
}

function boomProgress(card) {
    const rows = [];
    for (const anim of card.getAnimations({ subtree: true })) {
        const el = anim.effect && anim.effect.target;
        if (!el || !el.closest || !liveFire(card) || !liveFire(card).contains(el)) continue;
        rows.push({ el, progress: anim.effect.getComputedTiming().progress });
    }
    return rows;
}

function seekBoomReverse(card, rows) {
    const byEl = new Map(rows.map(row => [row.el, row]));
    for (const anim of card.getAnimations({ subtree: true })) {
        const el = anim.effect && anim.effect.target;
        const prev = byEl.get(el);
        if (!prev) continue;
        if (prev.progress == null) {
            el.style.animation = 'none';
            anim.cancel();
            continue;
        }
        const dur = anim.effect.getComputedTiming().duration;
        if (typeof dur === 'number') anim.currentTime = dur * (1 - prev.progress);
        if (anim.playState === 'paused') anim.play();
    }
}

function clearPaneAnimations(card) {
    card.getAnimations({ subtree: true }).forEach(anim => anim.cancel());
}

function blastRev1Hold(card) {
    clearTimeout(card._blastTimer);
    card._blastTimer = 0;
    card._phase = 'hold';
    mountHeatFire(card, boomMarkup());
    card.classList.remove('fire-out', 'boom-play', 'boom-back', 'fire-hold', 'no-flame', 'on-fire');
    void card.offsetWidth;
    card.classList.add('on-fire');
}

function blastRev1Release(card) {
    card._held = false;
    card._frozen = false;
    card._phase = 'out';
    clearPaneAnimations(card);
    const fire = liveFire(card);
    if (fire && card._at) {
        fire.style.setProperty('--bx', `${card._at.x}%`);
        fire.style.setProperty('--by', `${card._at.y}%`);
    }
    card.classList.add('fire-out');
    blastArm(card, 1700, () => {
        if (card._phase !== 'out') return;
        card._phase = '';
        card.classList.remove('on-fire', 'fire-out');
        if (blastLive === card) blastLive = null;
    });
}

// Blasts tab. Each card is a press / corner / fire / release test, with its own mix of explosion drawings.
const BLAST_CARDS = [
    { title: 'Revision 1', text: 'Hold the fire. Release one comic blast at the click.', mode: 'rev1' },
    { title: 'Comic', text: 'Revision 2. Comic click and comic corners.', click: 'comic', corners: 'comic' },
    { title: 'Cartoon', text: 'Cartoon click and cartoon corners', click: 'cartoon', corners: 'cartoon' },
    { title: 'Nova', text: 'Nova click and nova corners', click: 'nova', corners: 'nova' },
    { title: 'Embers', text: 'Ember click and ember corners', click: 'ember', corners: 'ember' },
    { title: 'Shock', text: 'Shock click and shock corners', click: 'shock', corners: 'shock' },
    { title: 'Comic core', text: 'Comic click, cartoon corners', click: 'comic', corners: 'cartoon' },
    { title: 'Cartoon core', text: 'Cartoon click, comic corners', click: 'cartoon', corners: 'comic' },
    { title: 'Four corners', text: 'Shock click. Corners: comic, cartoon, nova, ember', click: 'shock', corners: ['comic', 'cartoon', 'nova', 'ember'] },
    { title: 'Mixed ring', text: 'Comic click. Corners: nova, ember, shock, cartoon', click: 'comic', corners: ['nova', 'ember', 'shock', 'cartoon'] },
    { title: 'Split', text: 'Nova click. Corners: comic, comic, cartoon, cartoon', click: 'nova', corners: ['comic', 'comic', 'cartoon', 'cartoon'] },
    { title: 'Puffy', text: 'Layered cartoon fireball, flash, rings, and sparks', click: 'puffy', corners: 'puffy' },
    { title: 'Flash', text: 'Stacked star flash only', click: 'flash', corners: 'flash' },
    { title: 'Debris', text: 'Dashed rings and scattering sparks', click: 'debris', corners: 'debris' },
    { title: 'Puffy core', text: 'Puffy click, cartoon corners', click: 'puffy', corners: 'cartoon' },
    { title: 'Puffy mix', text: 'Comic click. Corners: puffy, flash, debris, cartoon', click: 'comic', corners: ['puffy', 'flash', 'debris', 'cartoon'] },
    { title: 'Random', text: 'Each press rolls a new design for the click and every corner.', click: 'cartoon', corners: ['comic', 'nova', 'shock', 'puffy'], randomCorners: true },
    { title: 'Stack', text: 'While held, new blasts fade in on the pointer and keep playing there.', click: 'cartoon', corners: 'cartoon', stack: true },
    { title: 'Eight', text: 'Eight flame points around the pointer.', click: 'cartoon', corners: 'cartoon', flames: 8 },
    { title: 'Eight stack', text: 'Eight flame points. Blasts stack on the pointer and overlap. Corners stack.', click: 'cartoon', corners: 'cartoon', flames: 8, stack: true, overlap: true, cornerStack: [true, true, true, true] },
    { title: 'Eight mix', text: 'Eight flame points. Each random blast plays through slower.', click: 'cartoon', corners: 'cartoon', flames: 8, stack: true, slow: true },
    { title: 'Mix spin', text: 'Eight mix, slower, with the points spinning one way.', click: 'cartoon', corners: 'cartoon', flames: 8, stack: true, slow: true, spin: 'same' },
    { title: 'Spin', text: 'Eight flame points, all spinning the same way.', click: 'cartoon', corners: 'cartoon', flames: 8, spin: 'same' },
    { title: 'Counterspin', text: 'Eight flame points. Neighbors spin opposite ways.', click: 'cartoon', corners: 'cartoon', flames: 8, spin: 'alt' },
    { title: 'Counterspin stack', text: 'Counterspin. Explosions keep stacking in front of the flames.', click: 'cartoon', corners: 'cartoon', flames: 8, spin: 'alt', stack: true, overlap: true, layers: ['click', 'corner-3', 'corner-2', 'corner-1', 'corner-0', 'flames'] },
    { title: 'Size tide', text: 'A size LFO swells and shrinks the blasts.', click: 'cartoon', corners: 'cartoon', flames: 8, size: 1, lfos: [{ on: true, target: 'size', rate: 0.35, depth: 0.8 }] },
    { title: 'Flame rush', text: 'Eight flames. Speed rises and falls, then repeats.', click: 'cartoon', corners: 'cartoon', flames: 8, speed: 1, lfos: [{ on: true, target: 'speed', rate: 0.22, depth: 0.9 }] },
    { title: 'Flame breath', text: 'The flames swell and shrink on a loop.', click: 'cartoon', corners: 'cartoon', flames: 8, linkSize: false, flameSize: 1, lfos: [{ on: true, target: 'flameSize', rate: 0.28, depth: 0.75 }] },
    { title: 'Corner lag', text: 'Corner blasts drift between immediate and late.', click: 'cartoon', corners: 'cartoon', cornerDelay: 400, lfos: [{ on: true, target: 'cornerDelay', rate: 0.16, depth: 0.7 }] },
    { title: 'Nested rush', text: 'Flame speed rises and falls. A second LFO speeds and slows that rate.', click: 'cartoon', corners: 'cartoon', flames: 8, speed: 1, lfos: [{ on: true, target: 'speed', rate: 0.2, depth: 0.85 }, { on: true, target: 'lfo0.rate', rate: 0.08, depth: 0.75 }] }
];

const BLAST_KINDS = ['comic', 'cartoon', 'nova', 'ember', 'shock', 'puffy', 'flash', 'debris'];

function rollBlast(card) {
    const pick = () => BLAST_KINDS[Math.floor(Math.random() * BLAST_KINDS.length)];
    const click = pick();
    const corners = [0, 1, 2, 3].map(pick);
    card._spec.click = click;
    card._spec.corners = corners;
    const label = card.querySelector('.v');
    if (label) label.textContent = `${click} click. Corners: ${corners.join(', ')}`;
}

let blastLive = null;

function novaPieces() {
    return '<b class="blast-nova"></b><b class="blast-nova-ring"></b><b class="blast-shard"></b>';
}

function emberPieces() {
    return '<b class="blast-ember"></b><b class="blast-puff"></b>';
}

function shockPieces() {
    return '<b class="blast-shock"></b><b class="blast-shock2"></b><b class="blast-glint"></b>';
}

const CX_BLOBS = [
    { a: 0, s: 24, ds: 5, de: 32 },
    { a: 30, s: 18, ds: 8, de: 29 },
    { a: 60, s: 27, ds: 4, de: 35 },
    { a: 90, s: 21, ds: 8, de: 27 },
    { a: 120, s: 24, ds: 6, de: 30 },
    { a: 150, s: 16, ds: 10, de: 26 },
    { a: 180, s: 29, ds: 3, de: 37 },
    { a: 210, s: 19, ds: 8, de: 29 },
    { a: 240, s: 26, ds: 5, de: 34 },
    { a: 270, s: 22, ds: 6, de: 32 },
    { a: 300, s: 27, ds: 4, de: 35 },
    { a: 330, s: 19, ds: 8, de: 27 }
];

function cxFlashPieces() {
    return [56, 44, 28, 16].map((size, i) => `<b class="cx-flash cx-tone-${i}" style="--s:${size}px;--lag:${i * 0.02}s"></b>`).join('');
}

function cxBlobPieces() {
    const tones = [1.15, 1, 0.7, 0.35];
    return tones.map((mod, tone) => CX_BLOBS.map(blob => `<b class="cx-blob cx-tone-${tone}" style="--a:${blob.a}deg;--s:${blob.s}px;--ds:${blob.ds}px;--de:${blob.de}px;--scale-mod:${mod}"></b>`).join('')).join('');
}

function cxDebrisPieces() {
    const rings = `<b class="cx-ring cx-ring-1"></b><b class="cx-ring cx-ring-2"></b>`;
    const outer = [15, 75, 135, 195, 250, 315].map((angle, i) => `<b class="cx-spark" style="--a:${angle}deg;--de:${42 + (i % 3) * 6}px;--s:${5 + (i % 3)}px"></b>`).join('');
    const inner = [25, 115, 205, 295].map(angle => `<b class="cx-spark cx-spark-in" style="--a:${angle}deg;--de:32px;--s:4px"></b>`).join('');
    return rings + outer + inner;
}

function puffyPieces() {
    return cxFlashPieces() + cxBlobPieces() + cxDebrisPieces();
}

function blastPieces(kind) {
    if (kind === 'cartoon') return rev3Pieces();
    if (kind === 'nova') return novaPieces();
    if (kind === 'ember') return emberPieces();
    if (kind === 'shock') return shockPieces();
    if (kind === 'puffy') return puffyPieces();
    if (kind === 'flash') return cxFlashPieces();
    if (kind === 'debris') return cxDebrisPieces();
    return boomPieces();
}

function layerOrder(spec) {
    const front = [];
    if (spec.clickOn !== false) front.push('click');
    if (cornerOnOf(spec, 3)) front.push('corner-3');
    if (cornerOnOf(spec, 2)) front.push('corner-2');
    if (cornerOnOf(spec, 1)) front.push('corner-1');
    if (cornerOnOf(spec, 0)) front.push('corner-0');
    if (spec.flamesOn !== false) front.push('flames');
    const saved = (Array.isArray(spec.layers) ? spec.layers : []).filter(id => front.includes(id));
    front.forEach(id => { if (!saved.includes(id)) saved.push(id); });
    return saved;
}

function cornerDevice(i) {
    return document.querySelector(`[data-layer="corner-${i}"]`);
}

function deviceOrder(spec) {
    const all = ['click', 'corner-3', 'corner-2', 'corner-1', 'corner-0', 'flames'];
    const saved = (Array.isArray(spec.layers) ? spec.layers : []).filter(id => all.includes(id));
    all.forEach(id => { if (!saved.includes(id)) saved.push(id); });
    return saved;
}

function layerZ(spec, id) {
    const order = layerOrder(spec);
    const at = order.indexOf(id);
    return at < 0 ? 0 : order.length - at;
}

function pieceSpeed(spec, which) {
    const fire = spec.speed || 1;
    if (spec.linkSpeed !== false) return fire;
    if (which === 'click') return spec.clickSpeed || fire;
    const speeds = Array.isArray(spec.cornerSpeeds) ? spec.cornerSpeeds : [];
    return speeds[which] || fire;
}

function pieceSize(spec, which) {
    if (spec.linkSize !== false) return 1;
    const master = spec.size || 1;
    if (which === 'flame') return spec.flameSize || master;
    if (which === 'click') return spec.clickSize || master;
    const sizes = Array.isArray(spec.cornerSizes) ? spec.cornerSizes : [];
    return sizes[which] || master;
}

function boomScale(spec) {
    return spec.linkSize !== false ? (spec.size || 1) : 1;
}

function cornerDelayOf(spec, i) {
    if (Array.isArray(spec.cornerDelays) && spec.cornerDelays[i] != null) return spec.cornerDelays[i];
    return spec.cornerDelay == null ? 500 : spec.cornerDelay;
}

function cornerOnOf(spec, i) {
    if (spec.cornersOn === false) return false;
    if (Array.isArray(spec.cornerOn)) return spec.cornerOn[i] !== false;
    return true;
}

function cornerSizesOf(spec) {
    const sizes = Array.isArray(spec.cornerSizes) ? spec.cornerSizes : [];
    return [0, 1, 2, 3].map(i => sizes[i] || 1);
}

function pickBlastKind() {
    return BLAST_KINDS[Math.floor(Math.random() * BLAST_KINDS.length)];
}

function blastCornerKinds(spec) {
    return Array.isArray(spec.corners) ? spec.corners : [spec.corners, spec.corners, spec.corners, spec.corners];
}

function rollCornerStyles(spec) {
    const raw = blastCornerKinds(spec);
    if (!Array.isArray(spec.corners) && spec.corners === 'random') {
        const kind = pickBlastKind();
        return [kind, kind, kind, kind];
    }
    return raw.map(kind => kind === 'random' ? pickBlastKind() : kind);
}

function flameTags(spec) {
    if (spec && spec.flamesOn === false) return '';
    const n = Math.max(2, Math.min(16, (spec && spec.flames) || 4));
    const start = n === 4 ? -135 : -90;
    const step = 360 / n;
    const spin = spec && spec.spin;
    const inner = Array.from({ length: n }, (_, i) => {
        const dir = spin === 'alt' ? (i % 2 ? 'spin-b' : 'spin-a') : (spin ? 'spin-a' : '');
        return `<b class="boom-flame ${dir}" style="--r:${start + i * step}deg;--d:${(i * 0.07).toFixed(2)}s"></b>`;
    }).join('');
    const z = layerZ(spec || {}, 'flames');
    return `<span class="heat-flames" style="--flame-size:${pieceSize(spec || {}, 'flame')};z-index:${z}">${inner}</span>`;
}

function blastMarkup(at, spec, roll) {
    const flames = flameTags(spec);
    const pad = spec.inset ? 14 : 0;
    const far = spec.inset ? 86 : 100;
    const spots = [[pad, pad], [far, pad], [pad, far], [far, far]];
    const kinds = roll || blastCornerKinds(spec);
    const groups = [];
    if (spec.clickOn !== false) groups.push(boomGroup(at.x, at.y, 'click', blastPieces(spec.click), pieceSize(spec, 'click'), layerZ(spec, 'click'), pieceSpeed(spec, 'click'), 0));
    spots.forEach(([x, y], i) => {
        if (!cornerOnOf(spec, i)) return;
        groups.push(boomGroup(x, y, 'corner', blastPieces(kinds[i]), pieceSize(spec, i), layerZ(spec, `corner-${i}`), pieceSpeed(spec, i), cornerDelayOf(spec, i), i));
    });
    return flames + groups.join('');
}

function cornerLoopGap(spec) {
    const waits = [0, 1, 2, 3].filter(i => cornerOnOf(spec, i)).map(i => cornerDelayOf(spec, i));
    const gap = waits.length ? Math.max(...waits) : 500;
    return Math.max(200, gap);
}

function spawnCornerSet(card) {
    const fire = liveFire(card);
    const spec = card._spec;
    if (!fire || !spec || !spec.cornerLoop) return;
    const pad = spec.inset ? 14 : 0;
    const far = spec.inset ? 86 : 100;
    const spots = [[pad, pad], [far, pad], [pad, far], [far, far]];
    const kinds = card._cornerRoll || blastCornerKinds(spec);
    const html = spots.map(([x, y], i) => {
        if (!cornerOnOf(spec, i)) return '';
        return boomGroup(x, y, 'corner', blastPieces(kinds[i]), pieceSize(spec, i), layerZ(spec, `corner-${i}`), pieceSpeed(spec, i), 0, i);
    }).join('');
    if (html) fire.insertAdjacentHTML('beforeend', html);
    [0, 1, 2, 3].forEach(i => {
        const nodes = [...fire.querySelectorAll(`.boom-corner[data-corner="${i}"]`)];
        while (nodes.length > 4) nodes.shift().remove();
    });
}

function cornerStackOf(spec, i) {
    return Array.isArray(spec.cornerStack) && !!spec.cornerStack[i];
}

function spawnCornerStack(card, i) {
    const fire = liveFire(card);
    const spec = card._spec;
    if (!fire || !spec || !cornerOnOf(spec, i)) return;
    const pad = spec.inset ? 14 : 0;
    const far = spec.inset ? 86 : 100;
    const [x, y] = [[pad, pad], [far, pad], [pad, far], [far, far]][i];
    const kinds = card._cornerRoll || blastCornerKinds(spec);
    const boom = document.createElement('span');
    boom.className = 'boom boom-corner boom-stack';
    boom.dataset.corner = String(i);
    boom.style.setProperty('--bx', `${x}%`);
    boom.style.setProperty('--by', `${y}%`);
    const speed = pieceSpeed(spec, i);
    boom.style.setProperty('--piece-size', pieceSize(spec, i));
    boom.style.setProperty('--play', speed);
    boom.style.setProperty('--corner-delay', '0ms');
    boom.classList.toggle('own-speed', speed !== 1);
    boom.style.zIndex = layerZ(spec, `corner-${i}`);
    boom.innerHTML = blastPieces(kinds[i]);
    fire.appendChild(boom);
    const nodes = [...fire.querySelectorAll(`.boom-corner[data-corner="${i}"]`)];
    while (nodes.length > 6) nodes.shift().remove();
}

function clearCornerStacks(card) {
    (card._cornerStackTimers || []).forEach(timer => clearTimeout(timer));
    card._cornerStackTimers = [];
}

function startCornerStacks(card) {
    clearCornerStacks(card);
    if (!card._spec) return;
    [0, 1, 2, 3].forEach(i => {
        if (!cornerOnOf(card._spec, i) || !cornerStackOf(card._spec, i)) return;
        const queue = () => {
            const gap = Math.max(120, cornerDelayOf(card._spec, i) || 220);
            card._cornerStackTimers[i] = setTimeout(() => {
                if (!card._held || card._frozen || card._phase === 'implode' || card._phase === '') return;
                spawnCornerStack(card, i);
                queue();
            }, gap);
        };
        spawnCornerStack(card, i);
        queue();
    });
}

function startCornerLoop(card) {
    clearTimeout(card._cornerTimer);
    if (!card._spec || !card._spec.cornerLoop) return;
    const queue = () => {
        card._cornerTimer = setTimeout(() => {
            if (!card._held || card._frozen || card._phase === 'implode' || card._phase === '') return;
            spawnCornerSet(card);
            queue();
        }, cornerLoopGap(card._spec));
    };
    queue();
}

function blastArm(card, ms, done) {
    clearTimeout(card._blastTimer);
    card._blastTimer = setTimeout(() => {
        card._blastTimer = 0;
        done();
    }, ms);
}

function flameMarkup() {
    return [-135, -45, 45, 135].map((angle, i) => `<b class="boom-flame" style="--r:${angle}deg;--d:${(i * 0.11).toFixed(2)}s"></b>`).join('');
}

function spawnStackBlast(card) {
    const fire = liveFire(card);
    if (!fire || card._spec.clickOn === false) return;
    const kind = card._spec.overlap ? card._spec.click : BLAST_KINDS[Math.floor(Math.random() * BLAST_KINDS.length)];
    const at = card._at || { x: 50, y: 50 };
    const boom = document.createElement('span');
    boom.className = 'boom boom-click boom-stack';
    boom.style.setProperty('--bx', `${at.x}%`);
    boom.style.setProperty('--by', `${at.y}%`);
    const speed = pieceSpeed(card._spec, 'click');
    boom.style.setProperty('--piece-size', pieceSize(card._spec, 'click'));
    boom.style.setProperty('--play', speed);
    boom.classList.toggle('own-speed', speed !== 1);
    boom.style.zIndex = layerZ(card._spec, 'click');
    boom.innerHTML = blastPieces(kind);
    fire.appendChild(boom);
    const clicks = fire.querySelectorAll('.boom-click');
    const gap = card._spec.gap || (card._spec.slow && !card._spec.speed ? 1600 : Math.round(220 / (card._spec.speed || 1)));
    const cap = card._spec.overlap ? 8 : (card._spec.slow || gap >= 1000 ? 3 : 6);
    if (clicks.length > cap) clicks[0].remove();
    const label = card.querySelector('.v');
    if (label) label.textContent = `${clicks.length} playing. Latest: ${kind}.`;
}

function startStackQueue(card) {
    clearTimeout(card._stackTimer);
    const queue = () => {
        const gap = card._spec.gap || (card._spec.slow && !card._spec.speed ? 1600 : Math.round(220 / (card._spec.speed || 1)));
        card._stackTimer = setTimeout(() => {
            if (!card._held || card._frozen || card._phase === 'implode' || card._phase === '') return;
            spawnStackBlast(card);
            queue();
        }, gap);
    };
    queue();
}

function blastStack(card) {
    clearTimeout(card._blastTimer);
    card._blastTimer = 0;
    card._phase = 'boom';
    card._saw = false;
    clearTimeout(card._stackTimer);
    mountHeatFire(card, flameTags(card._spec));
    card.classList.remove('fire-hold', 'boom-back', 'on-fire', 'fire-out', 'no-flame');
    card.classList.add('boom-play', 'stack');
    if (card._spec.slow) card.classList.add('slow');
    spawnStackBlast(card);
    startStackQueue(card);
    startCornerLoop(card);
    startCornerStacks(card);
    blastArm(card, HEAT_FIRE_IN_MS, () => {
        if (card._held && card._phase === 'boom') blastBurn(card);
    });
}

function blastExplode(card) {
    clearTimeout(card._blastTimer);
    card._blastTimer = 0;
    card._phase = 'boom';
    card._saw = false;
    mountHeatFire(card, blastMarkup(card._at, card._spec, card._cornerRoll));
    card.classList.remove('fire-hold', 'boom-back', 'on-fire', 'fire-out', 'no-flame');
    card.classList.add('boom-play');
    startCornerLoop(card);
    startCornerStacks(card);
    blastArm(card, HEAT_FIRE_IN_MS, () => {
        if (card._held && card._phase === 'boom') blastBurn(card);
    });
}

function blastBurn(card) {
    card._phase = 'burn';
    card._saw = true;
    if (!liveFire(card) || !liveFire(card).querySelector('.boom')) mountHeatFire(card, blastMarkup(card._at, card._spec, card._cornerRoll));
    card.classList.remove('boom-back', 'fire-out');
    card.classList.add('fire-hold', 'on-fire', 'boom-play');
    placeHeatmapFire(card, card._flame);
    pauseClickBlasts(card);
}

function blastPark(card, event) {
    const at = heatClickPoint(card, event);
    if (!at) return;
    card._at = at;
    card._flame = at;
    const fire = liveFire(card);
    if (fire) fire.querySelectorAll('.boom').forEach(boom => {
        boom.style.setProperty('--bx', `${at.x}%`);
        boom.style.setProperty('--by', `${at.y}%`);
    });
    placeHeatmapFire(card, at);
}

function blastImplode(card) {
    if (!card || card._phase === 'implode' || card._phase === '') return;
    clearTimeout(card._stackTimer);
    clearTimeout(card._cornerTimer);
    clearCornerStacks(card);
    card._phase = 'implode';
    card._held = false;
    if (!liveFire(card) || !liveFire(card).querySelector('.boom')) mountHeatFire(card, blastMarkup(card._at, card._spec, card._cornerRoll));
    const shots = boomProgress(card);
    clearPaneAnimations(card);
    card._frozen = false;
    card.classList.remove('boom-play', 'fire-hold', 'on-fire', 'fire-out');
    card.classList.toggle('no-flame', !card._saw);
    card.classList.add('boom-back');
    void card.offsetWidth;
    seekBoomReverse(card, shots);
    const rate = card._spec.speed || (card._spec.slow ? 0.5 : 1);
    blastArm(card, Math.round((card._spec.slow && !card._spec.speed ? 3000 : HEAT_BOOM_MS) / (card._spec.speed ? rate : 1)) + 80, () => {
        if (card._phase !== 'implode') return;
        card._phase = '';
        card.classList.remove('boom-back', 'boom-play', 'fire-hold', 'on-fire', 'no-flame');
        if (blastLive === card) blastLive = null;
        if (card.classList.contains('stage-pane') && card._spec) renderPane(card, card._spec);
    });
}

const PRESET_KEY = 'blast-lab-presets';
const FACTORY_KEY = 'blast-lab-factory';

function byId(id) {
    return document.getElementById(id);
}

function deviceIsOn() {
    const button = byId('des-on');
    return !button || button.getAttribute('aria-pressed') !== 'false';
}

function setDeviceOn(on) {
    const button = byId('des-on');
    if (!button) return;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Device on' : 'Device off');
    byId('blast-designer').classList.toggle('off', !on);
}

function flameSpan(spec) {
    const n = Math.max(2, Math.min(16, (spec && spec.flames) || 4));
    if (n === 8) return 16;
    if (n === 4) return 38;
    return Math.min(38, 128 / n);
}

function cardClass(spec) {
    const n = spec.flames || 4;
    const flags = [
        n === 8 ? 'flame-8' : '',
        n !== 4 && n !== 8 ? 'flame-n' : '',
        spec.spin ? 'flame-spin' : '',
        spec.slow ? 'slow' : '',
        spec.speed && spec.speed !== 1 ? 'paced' : ''
    ].filter(Boolean);
    return ['stats-card', 'heat-rev-3', 'blast-card', ...flags].join(' ');
}

function syncStage(card) {
    if (!card) return;
    const box = card.getBoundingClientRect();
    const next = Math.round(Math.min(box.width, box.height));
    if (!next || card._stage === next) return;
    card._stage = next;
    card.style.setProperty('--stage', String(next));
}

function paintCard(card, spec) {
    syncStage(card);
    card.className = cardClass(spec);
    card._spec = spec;
    card.style.setProperty('--fw', String(flameSpan(spec)));
    card.style.setProperty('--corner-delay', `${spec.cornerDelay == null ? 500 : spec.cornerDelay}ms`);
    if (spec.speed && spec.speed !== 1) card.style.setProperty('--play', String(spec.speed));
    else card.style.removeProperty('--play');
    card.style.setProperty('--boom-size', String(boomScale(spec)));
    const title = card.querySelector('.k');
    const text = card.querySelector('.v');
    if (title) title.textContent = spec.title;
    if (text && !card._held) text.textContent = spec.text;
    if (card.id === 'des-preview') paintCopy();
}

function bindBlastCard(card) {
        card._phase = '';
        card._at = { x: 50, y: 50 };
        card._flame = { x: 50, y: 50 };
        card.onpointerdown = event => {
        if (card.id === 'des-preview') paintCard(card, readDesignerSpec());
        if (card._spec.on === false) return;
            if (blastLive && blastLive !== card) blastImplode(blastLive);
            blastLive = card;
            card._held = true;
            const at = heatClickPoint(card, event);
        if (at && card.id === 'des-preview') {
            card._spot = at;
            placeStageSpot(card);
        }
        if (at && card.id === 'des-preview' && card._front) {
            playStage(card, at);
            return;
        }
            if (at) {
                card._at = at;
                card._flame = at;
            }
        if (card._spec.randomCorners) rollBlast(card);
        card._cornerRoll = rollCornerStyles(card._spec);
            if (card._spec.mode === 'rev1') blastRev1Hold(card);
        else if (card._spec.stack) blastStack(card);
            else blastExplode(card);
        };
}

function designerText(spec) {
    if (spec.mode === 'rev1') return 'Hold the fire. Release one comic blast at the click.';
    const bits = [`${spec.flames || 4} flames`, spec.randomCorners ? 'random blasts' : `${spec.click} click`];
    if (spec.clickOn === false) bits.push('no click blast');
    if (spec.cornersOn === false) bits.push('no corners');
    if (spec.cornerDelay != null && spec.cornerDelay !== 500) bits.push(`corners +${spec.cornerDelay}ms`);
    if (spec.cornerLoop) bits.push('continuous corners');
    if ((spec.cornerStack || []).some(Boolean)) bits.push('corner stack');
    if (spec.flamesOn === false) bits.push('no flames');
    if (spec.corners === 'random' || (Array.isArray(spec.corners) && spec.corners.indexOf('random') >= 0)) bits.push('random corner');
    if (spec.spin === 'same') bits.push('spin');
    if (spec.spin === 'alt') bits.push('counterspin');
    if (spec.stack && spec.overlap) bits.push('stacked overlap');
    else if (spec.stack) bits.push(spec.gap && spec.gap !== 220 ? `stacked ${spec.gap}ms` : 'stacked');
    if (spec.size && spec.size !== 1) bits.push(`size ${spec.size}`);
    if ((spec.lfos || []).some(slot => slot.on && slot.target === 'size')) bits.push('size LFO');
    if (spec.speed && spec.speed !== 1) bits.push(`${spec.speed}×`);
    else if (spec.slow) bits.push('slow');
    return bits.join(', ');
}

function cornerModeFor(spec) {
    if (spec.randomCorners) return 'random';
    if (Array.isArray(spec.corners)) return 'each';
    if (spec.corners && spec.corners !== spec.click) return 'one';
    return 'match';
}

function readDesignerSpec() {
    const title = byId('des-name').value.trim() || 'Custom';
    if (byId('des-pattern').value === 'rev1') {
        return { title, mode: 'rev1', on: deviceIsOn(), flames: 4, click: 'comic', corners: 'comic', text: designerText({ mode: 'rev1' }) };
    }
    const click = byId('des-click').value;
    const mode = byId('des-corners').value;
    const stack = byId('des-stack').checked || byId('des-overlap').checked;
    let corners = click;
    if (mode === 'each') corners = [0, 1, 2, 3].map(i => cornerDevice(i).querySelector('.des-corner').value);
    if (mode === 'one') corners = byId('des-corner-one').value;
    const spec = {
        title,
        on: deviceIsOn(),
        click,
        clickOn: byId('des-click-on').checked,
        cornersOn: [...document.querySelectorAll('.corner-on')].some(el => el.checked),
        cornerOn: [0, 1, 2, 3].map(i => cornerDevice(i).querySelector('.corner-on').checked),
        flamesOn: byId('des-flames-on').checked,
        clickSize: Number(byId('des-click-size').value),
        clickSpeed: Number(byId('des-click-speed').value),
        flameSize: Number(byId('des-flame-size').value),
        cornerSizes: [0, 1, 2, 3].map(i => Number(cornerDevice(i).querySelector('.corner-size').value)),
        cornerSpeeds: [0, 1, 2, 3].map(i => Number(cornerDevice(i).querySelector('.corner-speed').value)),
        cornerDelays: [0, 1, 2, 3].map(i => Number(cornerDevice(i).querySelector('.corner-delay').value)),
        cornerStack: [0, 1, 2, 3].map(i => cornerDevice(i).querySelector('.corner-stack').checked),
        layers: [...document.querySelectorAll('#dev-chain [data-layer]')].map(el => el.dataset.layer),
        corners,
        flames: Number(byId('des-flames').value),
        stack,
        overlap: stack && byId('des-overlap').checked,
        speed: Number(byId('des-speed').value),
        linkSpeed: byId('des-link-speed').checked,
        linkSize: byId('des-link-size').checked,
        size: Number(byId('des-size').value),
        gap: stack ? Number(byId('des-gap').value) : 0,
        lfos: readLfoDevices(),
        inset: byId('des-inset').checked,
        cornerLoop: byId('des-corner-loop').checked,
        randomCorners: mode === 'random'
    };
    if (byId('des-spin').value) spec.spin = byId('des-spin').value;
    spec.text = designerText(spec);
    return spec;
}

function writeDesignerSpec(spec) {
    setDeviceOn(spec.on !== false);
    byId('des-name').value = spec.title || 'Custom';
    byId('des-pattern').value = spec.mode === 'rev1' ? 'rev1' : 'blast';
    if (spec.click) byId('des-click').value = spec.click;
    byId('des-click-on').checked = spec.clickOn !== false;
    byId('des-link-speed').checked = spec.linkSpeed !== false;
    byId('des-link-size').checked = spec.linkSize !== false;
    const cornerOn = Array.isArray(spec.cornerOn) ? spec.cornerOn : [0, 1, 2, 3].map(() => spec.cornersOn !== false);
    [0, 1, 2, 3].forEach(i => {
        const dev = cornerDevice(i);
        dev.querySelector('.corner-on').checked = spec.cornersOn !== false && cornerOn[i] !== false;
        dev.querySelector('.corner-size').value = cornerSizesOf(spec)[i];
        dev.querySelector('.corner-speed').value = (spec.cornerSpeeds && spec.cornerSpeeds[i]) || spec.speed || 1;
        dev.querySelector('.corner-delay').value = cornerDelayOf(spec, i);
        dev.querySelector('.corner-stack').checked = cornerStackOf(spec, i);
        if (Array.isArray(spec.corners) && spec.corners[i]) dev.querySelector('.des-corner').value = spec.corners[i];
    });
    byId('des-flames-on').checked = spec.flamesOn !== false;
    byId('des-click-size').value = spec.clickSize || 1;
    byId('des-click-speed').value = spec.clickSpeed || spec.speed || 1;
    byId('des-flame-size').value = spec.flameSize || 1;
    renderLayerList(deviceOrder(spec));
    byId('des-inset').checked = !!spec.inset;
    byId('des-corner-loop').checked = !!spec.cornerLoop;
    byId('des-corners').value = cornerModeFor(spec);
    if (!Array.isArray(spec.corners) && spec.corners) byId('des-corner-one').value = spec.corners;
    byId('des-flames').value = spec.flames || 4;
    byId('des-spin').value = spec.spin || '';
    byId('des-stack').checked = !!spec.stack;
    byId('des-overlap').checked = !!spec.overlap;
    byId('des-speed').value = spec.speed || (spec.slow ? 0.5 : 1);
    byId('des-size').value = spec.size || 1;
    writeLfoDevices(lfoList(spec));
    byId('des-gap').value = spec.gap || (spec.slow ? 1600 : 220);
}

const LFO_TARGETS = [
    { id: 'pattern', kind: 'list', values: ['blast', 'rev1'] },
    { id: 'clickOn', kind: 'bool' },
    { id: 'click', kind: 'list', values: () => BLAST_KINDS },
    { id: 'cornersOn', kind: 'bool' },
    { id: 'corners', kind: 'list', values: ['match', 'one', 'each', 'random'] },
    { id: 'flamesOn', kind: 'bool' },
    { id: 'flames', kind: 'range', min: 2, max: 16 },
    { id: 'spin', kind: 'list', values: ['', 'same', 'alt'] },
    { id: 'stack', kind: 'bool' },
    { id: 'overlap', kind: 'bool' },
    { id: 'gap', kind: 'range', min: 120, max: 2000 },
    { id: 'cornerDelay', kind: 'range', min: 0, max: 2000 },
    { id: 'speed', kind: 'range', min: 0.25, max: 2 },
    { id: 'linkSpeed', kind: 'bool' },
    { id: 'linkSize', kind: 'bool' },
    { id: 'clickSpeed', kind: 'range', min: 0.25, max: 2 },
    { id: 'cSpeed0', kind: 'range', min: 0.25, max: 2 },
    { id: 'cSpeed1', kind: 'range', min: 0.25, max: 2 },
    { id: 'cSpeed2', kind: 'range', min: 0.25, max: 2 },
    { id: 'cSpeed3', kind: 'range', min: 0.25, max: 2 },
    { id: 'cDelay0', kind: 'range', min: 0, max: 2000 },
    { id: 'cDelay1', kind: 'range', min: 0, max: 2000 },
    { id: 'cDelay2', kind: 'range', min: 0, max: 2000 },
    { id: 'cDelay3', kind: 'range', min: 0, max: 2000 },
    { id: 'size', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'clickSize', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'flameSize', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'c0', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'c1', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'c2', kind: 'range', min: 0.35, max: 2.4 },
    { id: 'c3', kind: 'range', min: 0.35, max: 2.4 }
];

function lfoModTarget(id) {
    const built = LFO_TARGETS.find(item => item.id === id);
    if (built) return built;
    const match = /^lfo(\d+)\.(rate|depth)$/.exec(id || '');
    if (!match) return null;
    if (match[2] === 'rate') return { id, kind: 'range', min: 0.05, max: 2 };
    return { id, kind: 'range', min: 0, max: 1 };
}

function lfoTargetOptions(count) {
    const extras = [];
    for (let i = 0; i < count; i += 1) extras.push(`lfo${i}.rate`, `lfo${i}.depth`);
    return LFO_TARGETS.map(target => target.id).concat(extras);
}

function lfoValues(target) {
    return typeof target.values === 'function' ? target.values() : target.values;
}

function lfoList(spec) {
    if (!spec) return [];
    if (Array.isArray(spec.lfos)) return spec.lfos;
    if (!spec.lfo || typeof spec.lfo !== 'object') return [];
    return Object.entries(spec.lfo).filter(([, slot]) => slot && slot.on).map(([target, slot]) => ({
        on: true, target, rate: slot.rate, depth: slot.depth
    }));
}

function lfoNodes() {
    return [...document.querySelectorAll('#dev-chain .lfo-device')].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
}

function readLfoDevices() {
    return lfoNodes().map(el => ({
        on: el.querySelector('.lfo-on').checked,
        target: el.querySelector('.lfo-target').value,
        rate: Number(el.querySelector('.lfo-rate').value),
        depth: Number(el.querySelector('.lfo-depth').value)
    }));
}

function placeLfos() {
    const chain = byId('dev-chain');
    if (!chain) return;
    const lfos = lfoNodes();
    const placed = new Set();
    const park = (node, anchor) => {
        let after = anchor;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains('lfo-device') && placed.has(after.nextElementSibling)) after = after.nextElementSibling;
        after.after(node);
        placed.add(node);
    };
    lfos.forEach(node => {
        const target = node.querySelector('.lfo-target').value;
        if (/^lfo\d+\./.test(target)) return;
        const param = chain.querySelector(`[data-lfo="${target}"]`);
        const device = param && param.closest('.device');
        if (device) park(node, device);
    });
    let guard = lfos.length;
    while (placed.size < lfos.length && guard) {
        guard -= 1;
        lfos.forEach(node => {
            if (placed.has(node)) return;
            const match = /^lfo(\d+)\./.exec(node.querySelector('.lfo-target').value || '');
            const host = match && chain.querySelector(`.lfo-device[data-index="${match[1]}"]`);
            if (host && placed.has(host)) park(node, host);
        });
    }
    lfos.forEach(node => { if (!placed.has(node)) chain.appendChild(node); });
}

function writeLfoDevices(list) {
    const chain = byId('dev-chain');
    if (!chain) return;
    chain.querySelectorAll('.lfo-device').forEach(el => el.remove());
    const options = lfoTargetOptions(list.length).map(id => `<option value="${id}">${id}</option>`).join('');
    chain.insertAdjacentHTML('beforeend', list.map((slot, i) => `<div class="lfo-device" data-index="${i}"><div class="lfo-title"><button type="button" class="fold" aria-expanded="true" aria-label="Fold device"></button><input type="checkbox" class="lfo-on" ${slot.on ? 'checked' : ''}> LFO ${i + 1} <button type="button" data-remove="${i}">×</button></div><label>Assign <select class="lfo-target">${options}</select></label><label data-lfo="lfo${i}.rate">Rate <input class="lfo-rate" type="range" min="0.05" max="2" step="0.05" value="${slot.rate || 0.4}"></label><label data-lfo="lfo${i}.depth">Depth <input class="lfo-depth" type="range" min="0" max="1" step="0.05" value="${slot.depth == null ? 0.5 : slot.depth}"></label><b class="lfo-live"></b></div>`).join(''));
    chain.querySelectorAll('.lfo-target').forEach((select, i) => { select.value = list[i].target || 'size'; });
    placeLfos();
    paintKnobs(chain);
}

function modulate(base, target, slot, now) {
    if (!slot || !slot.on || !slot.depth) return base;
    const wave = Math.sin((now / 1000) * (slot.rate || 0.4) * Math.PI * 2);
    if (target.kind === 'range') {
        const span = (target.max - target.min) * slot.depth;
        return Math.min(target.max, Math.max(target.min, base + wave * span * 0.5));
    }
    if (target.kind === 'bool') return slot.depth >= 0.35 ? wave > 0 : base;
    const values = lfoValues(target);
    const index = Math.max(0, values.indexOf(base));
    const step = Math.round(wave * slot.depth * (values.length - 1) * 0.5);
    return values[Math.max(0, Math.min(values.length - 1, index + step))];
}

function applyTarget(live, target, next) {
    if (target.id === 'pattern') live.mode = next === 'rev1' ? 'rev1' : undefined;
    if (target.id === 'clickOn') live.clickOn = next;
    if (target.id === 'click') live.click = next;
    if (target.id === 'cornersOn') live.cornersOn = next;
    if (target.id === 'corners') {
        live.randomCorners = next === 'random';
        if (next === 'match') live.corners = live.click;
    }
    if (target.id === 'flamesOn') live.flamesOn = next;
    if (target.id === 'flames') live.flames = Math.round(next);
    if (target.id === 'spin') live.spin = next || undefined;
    if (target.id === 'stack') live.stack = next;
    if (target.id === 'overlap') live.overlap = next;
    if (target.id === 'gap') live.gap = Math.round(next);
    if (target.id === 'cornerDelay') {
        const ms = Math.round(next);
        live.cornerDelay = ms;
        live.cornerDelays = [ms, ms, ms, ms];
    }
    if (target.id === 'speed') live.speed = next;
    if (target.id === 'linkSpeed') live.linkSpeed = next;
    if (target.id === 'linkSize') live.linkSize = next;
    if (target.id === 'clickSpeed') live.clickSpeed = next;
    if (/^cSpeed[0-3]$/.test(target.id)) {
        live.cornerSpeeds = Array.isArray(live.cornerSpeeds) ? live.cornerSpeeds.slice() : [1, 1, 1, 1];
        live.cornerSpeeds[Number(target.id.slice(6))] = next;
    }
    if (/^cDelay[0-3]$/.test(target.id)) {
        live.cornerDelays = [0, 1, 2, 3].map(i => cornerDelayOf(live, i));
        live.cornerDelays[Number(target.id.slice(6))] = Math.round(next);
    }
    if (target.id === 'size') live.size = next;
    if (target.id === 'clickSize') live.clickSize = next;
    if (target.id === 'flameSize') live.flameSize = next;
    if (/^c[0-3]$/.test(target.id)) {
        live.cornerSizes = cornerSizesOf(live);
        live.cornerSizes[Number(target.id.slice(1))] = next;
    }
}

function liveSpec(base, now) {
    const live = { ...base, lfos: (base.lfos || []).map(slot => ({ ...slot })) };
    for (let i = live.lfos.length - 1; i >= 0; i -= 1) {
        const slot = live.lfos[i];
        const match = /^lfo(\d+)\.(rate|depth)$/.exec(slot.target || '');
        if (!match) continue;
        const dest = live.lfos[Number(match[1])];
        if (!dest || dest === slot) continue;
        const key = match[2];
        const target = lfoModTarget(slot.target);
        dest[key] = modulate(dest[key] == null ? (key === 'rate' ? 0.4 : 0.5) : dest[key], target, slot, now);
    }
    live.lfos.forEach((slot, i) => {
        const note = document.querySelector(`#dev-chain .lfo-device[data-index="${i}"] .lfo-live`);
        const match = /^lfo(\d+)\.(rate|depth)$/.exec(slot.target || '');
        if (match) {
            const dest = live.lfos[Number(match[1])];
            if (note && dest && dest !== slot) note.textContent = Number(dest[match[2]]).toFixed(2);
            return;
        }
        const target = lfoModTarget(slot.target);
        if (!target) return;
        const next = modulate(baseValue(base, target), target, slot, now);
        applyTarget(live, target, next);
        if (note) note.textContent = target.kind === 'bool' ? (next ? 'on' : 'off') : (target.kind === 'range' ? Number(next).toFixed(target.id === 'flames' ? 0 : 2) : String(next || 'still'));
    });
    return live;
}

function baseValue(spec, target) {
    if (target.id === 'pattern') return spec.mode === 'rev1' ? 'rev1' : 'blast';
    if (target.id === 'clickOn') return spec.clickOn !== false;
    if (target.id === 'click') return spec.click;
    if (target.id === 'cornersOn') return spec.cornersOn !== false;
    if (target.id === 'corners') return spec.randomCorners ? 'random' : (Array.isArray(spec.corners) ? 'each' : (spec.corners !== spec.click ? 'one' : 'match'));
    if (target.id === 'flamesOn') return spec.flamesOn !== false;
    if (target.id === 'flames') return spec.flames || 4;
    if (target.id === 'spin') return spec.spin || '';
    if (target.id === 'stack') return !!spec.stack;
    if (target.id === 'overlap') return !!spec.overlap;
    if (target.id === 'gap') return spec.gap || 220;
    if (target.id === 'cornerDelay') return spec.cornerDelay == null ? 500 : spec.cornerDelay;
    if (target.id === 'speed') return spec.speed || 1;
    if (target.id === 'linkSpeed') return spec.linkSpeed !== false;
    if (target.id === 'linkSize') return spec.linkSize !== false;
    if (target.id === 'clickSpeed') return spec.clickSpeed || spec.speed || 1;
    if (target.id === 'cSpeed0') return (spec.cornerSpeeds && spec.cornerSpeeds[0]) || spec.speed || 1;
    if (target.id === 'cSpeed1') return (spec.cornerSpeeds && spec.cornerSpeeds[1]) || spec.speed || 1;
    if (target.id === 'cSpeed2') return (spec.cornerSpeeds && spec.cornerSpeeds[2]) || spec.speed || 1;
    if (target.id === 'cSpeed3') return (spec.cornerSpeeds && spec.cornerSpeeds[3]) || spec.speed || 1;
    if (target.id === 'cDelay0') return cornerDelayOf(spec, 0);
    if (target.id === 'cDelay1') return cornerDelayOf(spec, 1);
    if (target.id === 'cDelay2') return cornerDelayOf(spec, 2);
    if (target.id === 'cDelay3') return cornerDelayOf(spec, 3);
    if (target.id === 'size') return spec.size || 1;
    if (target.id === 'clickSize') return spec.clickSize || 1;
    if (target.id === 'flameSize') return spec.flameSize || 1;
    if (target.id === 'c0') return cornerSizesOf(spec)[0];
    if (target.id === 'c1') return cornerSizesOf(spec)[1];
    if (target.id === 'c2') return cornerSizesOf(spec)[2];
    if (target.id === 'c3') return cornerSizesOf(spec)[3];
    return false;
}

function retuneFlames(card, spec) {
    card.classList.toggle('flame-spin', !!spec.spin && spec.flamesOn !== false);
    card.classList.toggle('paced', !!(spec.speed && spec.speed !== 1));
    card.classList.remove('over-fire');
    card.style.setProperty('--boom-size', String(boomScale(spec)));
    card.style.setProperty('--play', String(spec.speed || 1));
    card.style.setProperty('--fw', String(flameSpan(spec)));
    card.style.setProperty('--corner-delay', `${spec.cornerDelay == null ? 500 : spec.cornerDelay}ms`);
    if (spec.speed && spec.speed !== 1) card.style.setProperty('--play', String(spec.speed));
    const fire = liveFire(card);
    if (!fire || spec.flamesOn === false) return;
    const count = Math.max(2, spec.flames || 4);
    const flames = [...fire.querySelectorAll('.boom-flame')];
    if (flames.length !== count || (spec.spin === 'alt') !== flames.some(el => el.classList.contains('spin-b'))) {
        fire.querySelectorAll('.heat-flames, .boom-flame').forEach(el => el.remove());
        fire.insertAdjacentHTML('afterbegin', flameTags(spec));
    }
}

function renderLayerList(order) {
    const chain = byId('dev-chain');
    if (!chain) return;
    order.forEach(id => {
        const node = chain.querySelector(`[data-layer="${id}"]`);
        if (node) chain.appendChild(node);
    });
    placeLfos();
}

function applyLayerPaint(card, spec) {
    const fire = liveFire(card);
    if (!fire) return;
    const wrap = fire.querySelector('.heat-flames');
    if (wrap) {
        wrap.style.zIndex = layerZ(spec, 'flames');
        wrap.style.setProperty('--flame-size', pieceSize(spec, 'flame'));
    }
    if (spec.flamesOn === false) fire.querySelectorAll('.heat-flames, .boom-flame').forEach(el => el.remove());
    fire.querySelectorAll('.boom-click').forEach(el => {
        const speed = pieceSpeed(spec, 'click');
        el.style.zIndex = layerZ(spec, 'click');
        el.style.setProperty('--piece-size', pieceSize(spec, 'click'));
        el.style.setProperty('--play', speed);
        el.classList.toggle('own-speed', speed !== 1);
    });
    fire.querySelectorAll('.boom-corner').forEach(el => {
        const i = Number(el.dataset.corner);
        const speed = pieceSpeed(spec, i);
        el.style.zIndex = layerZ(spec, `corner-${i}`);
        el.style.setProperty('--piece-size', pieceSize(spec, i));
        el.style.setProperty('--play', speed);
        el.style.setProperty('--corner-delay', `${cornerDelayOf(spec, i)}ms`);
        el.classList.toggle('own-speed', speed !== 1);
    });
}

function tickLfos(now) {
    const card = byId('des-preview');
    if (!card || !card._spec) return;
    const base = readDesignerSpec();
    if (base.on === false) {
        card._spec = base;
        retuneFlames(card, base);
        requestAnimationFrame(tickLfos);
        return;
    }
    const live = liveSpec(base, now);
    card._spec = live;
    retuneFlames(card, live);
    applyLayerPaint(card, live);
    requestAnimationFrame(tickLfos);
}

function fillKindSelect(select, withRandom) {
    const kinds = withRandom ? ['random', ...BLAST_KINDS] : BLAST_KINDS;
    select.innerHTML = kinds.map(kind => `<option value="${kind}">${kind}</option>`).join('');
}

function syncDesignerFields() {
    byId('des-flames-n').textContent = byId('des-flames').value;
    byId('des-speed-n').textContent = `${byId('des-speed').value}×`;
    byId('des-gap-n').textContent = `${byId('des-gap').value}ms`;
    byId('des-click-speed-n').textContent = `${byId('des-click-speed').value}×`;
    byId('des-size-n').textContent = `${Number(byId('des-size').value).toFixed(2)}×`;
    const rev1 = byId('des-pattern').value === 'rev1';
    const cornerMode = byId('des-corners').value;
    if (byId('des-overlap').checked) byId('des-stack').checked = true;
    if (!byId('des-stack').checked) byId('des-overlap').checked = false;
    const stacking = byId('des-stack').checked;
    const linked = byId('des-link-speed').checked;
    const linkSize = byId('des-link-size').checked;
    document.querySelectorAll('.device').forEach(el => { el.hidden = rev1 && !el.classList.contains('host'); });
    document.querySelectorAll('.des-blast').forEach(el => { el.hidden = rev1; });
    const clickOn = byId('des-click-on').checked;
    const flamesOn = byId('des-flames-on').checked;
    const knobLabel = (label, disabled) => {
        if (!label || label.closest('.device[hidden]')) return;
        label.hidden = false;
        const input = label.querySelector('input[type="range"]');
        if (input) input.disabled = disabled;
    };
    byId('des-click-label').hidden = rev1 || !clickOn;
    byId('des-spin-label').hidden = rev1 || !flamesOn;
    knobLabel(byId('des-size').closest('label'), false);
    knobLabel(byId('des-gap-label'), !stacking);
    knobLabel(byId('des-speed-label'), false);
    knobLabel(byId('des-flames-label'), !flamesOn);
    knobLabel(byId('des-flame-size-label'), !flamesOn || linkSize);
    knobLabel(byId('des-click-size-label'), !clickOn || linkSize);
    knobLabel(document.querySelector('[data-layer="click"] .piece-speed'), !clickOn || linked);
    document.querySelectorAll('[data-layer^="corner-"]').forEach(dev => {
        const on = dev.querySelector('.corner-on').checked;
        dev.querySelector('.corner-kind-label').hidden = rev1 || !on || cornerMode !== 'each';
        knobLabel(dev.querySelector('.corner-size-label'), !on || linkSize);
        knobLabel(dev.querySelector('.piece-speed'), !on || linked);
        knobLabel(dev.querySelector('label[data-lfo^="cDelay"]'), !on);
    });
    byId('des-corner-one-label').hidden = rev1 || cornerMode !== 'one';
    byId('des-overlap-label').hidden = rev1 || !stacking;
}

function refreshDesigner() {
    syncDesignerFields();
    const name = byId('preset-name');
    if (name) name.textContent = byId('des-name').value.trim() || 'Custom';
    const preview = byId('des-preview');
    const spec = readDesignerSpec();
    if (preview && !preview._held) paintCard(preview, spec);
    placeLfos();
    paintKnobs(byId('blast-designer'));
}

let openKey = 'factory:0';

function catalog() {
    return [
        ...factoryPresets().map((spec, i) => ({ spec, key: `factory:${i}` })),
        ...loadPresets().map((spec, i) => ({ spec, key: `user:${i}` }))
    ];
}

function factoryPresets() {
    try {
        const saved = JSON.parse(localStorage.getItem(FACTORY_KEY));
        if (Array.isArray(saved) && saved.length) {
            return saved.map(spec => {
                const built = BLAST_CARDS.find(card => card.title === spec.title);
                if (!built || !built.cornerStack || spec.cornerStack) return spec;
                return { ...spec, cornerStack: built.cornerStack.slice() };
            });
        }
    } catch (err) { /* built-in factory stays */ }
    return BLAST_CARDS;
}

function loadPresets() {
    try {
        const saved = JSON.parse(localStorage.getItem(PRESET_KEY));
        return Array.isArray(saved) ? saved : [];
    } catch (err) {
        return [];
    }
}

function presetRecord(spec) {
    if (!spec || typeof spec !== 'object' || !spec.title) return null;
    const copy = { ...spec, text: spec.text || designerText(spec) };
    delete copy._held;
    return copy;
}

function savePresetList(list) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
    renderPresetList();
}

function renderPresetList() {
    const row = (spec, key) => `<li><button type="button" class="preset-row${key === openKey ? ' active' : ''}" data-key="${key}">${escapeHtml(spec.title)}</button></li>`;
    byId('factory-list').innerHTML = factoryPresets().map((spec, i) => row(spec, `factory:${i}`)).join('');
    const user = loadPresets();
    byId('preset-list').innerHTML = user.length ? user.map((spec, i) => row(spec, `user:${i}`)).join('') : '<li class="empty">No user presets</li>';
    document.querySelector('.preset-row.active')?.scrollIntoView({ block: 'nearest' });
}

function renderPane(pane, spec) {
    const preview = byId('des-preview');
    syncStage(preview);
    pane._spec = spec;
    pane._held = false;
    pane._phase = '';
    pane.className = `stage-pane ${cardClass(spec)}`;
    pane.style.setProperty('--boom-size', String(boomScale(spec)));
    pane.style.setProperty('--play', String(spec.speed || 1));
    pane.style.setProperty('--fw', String(flameSpan(spec)));
    const at = preview._spot || { x: 50, y: 50 };
    if (spec.mode === 'rev1') {
        mountHeatFire(pane, boomMarkup());
        pane.classList.remove('boom-play', 'fire-hold');
    } else {
        mountHeatFire(pane, blastMarkup(at, { ...spec, cornerDelays: [0, 0, 0, 0], cornerDelay: 0 }));
        placeHeatmapFire(pane, at);
    }
}

function showStage(spec) {
    const preview = byId('des-preview');
    if (!preview || !preview._front) return;
    renderPane(preview._front, spec);
    preview._front.style.opacity = '1';
    preview._back.style.opacity = '0';
    preview._backKey = null;
    preview._fade = 0;
    const bar = byId('stage-scroll');
    if (bar) {
        bar._lock = true;
        bar.scrollTop = 0;
        bar._index = 0;
        bar._lock = false;
    }
    paintFrames();
}

function nudgeStage(dir) {
    const bar = byId('stage-scroll');
    if (!bar) return;
    const h = bar.clientHeight || 1;
    const index = Math.round(bar.scrollTop / h);
    const next = index + dir;
    if (next > 2 || next < 0) {
        commitFade(next > 2 ? 1 : -1);
        const landed = byId('stage-scroll');
        const span = landed.clientHeight || 1;
        landed._lock = true;
        landed.scrollTop = span;
        landed._index = 1;
        landed._lock = false;
        applyFade(0.5);
        return;
    }
    bar._lock = true;
    bar.scrollTop = next * h;
    bar._index = next;
    bar._lock = false;
    applyFade(next / 2);
}

function syncStageScroll() {
    const bar = byId('stage-scroll');
    if (!bar || bar._lock) return;
    const h = bar.clientHeight || 1;
    const index = Math.max(0, Math.min(2, Math.round(bar.scrollTop / h)));
    if (index === bar._index) return;
    bar._index = index;
    applyFade(index / 2);
}

function stageNeighbor(dir) {
    const items = catalog();
    if (!items.length) return null;
    let index = items.findIndex(entry => entry.key === openKey);
    if (index < 0) index = 0;
    return items[(index + dir + items.length) % items.length];
}

function paneShown(pane) {
    return !!pane && Number(pane.style.opacity) > 0;
}

function pauseClickBlasts(pane) {
    pane.getAnimations({ subtree: true }).forEach(anim => {
        const el = anim.effect && anim.effect.target;
        if (!el || !el.closest || !el.closest('.boom') || el.closest('.boom-corner') || el.closest('.boom-stack')) return;
        anim.pause();
    });
}

function freezePane(pane) {
    if (!pane || pane._frozen || !pane._phase) return;
    pane._frozen = true;
    clearTimeout(pane._stackTimer);
    clearTimeout(pane._cornerTimer);
    clearTimeout(pane._blastTimer);
    clearCornerStacks(pane);
    pane.getAnimations({ subtree: true }).forEach(anim => anim.pause());
}

function resumePane(pane) {
    if (!pane || !pane._frozen) return;
    pane._frozen = false;
    pane.getAnimations({ subtree: true }).forEach(anim => {
        if (anim.playState === 'paused') anim.play();
    });
    if (!pane._held) return;
    if (pane._spec.stack && pane._phase !== 'hold') startStackQueue(pane);
    if (pane._phase === 'boom' || pane._phase === 'burn') {
        startCornerLoop(pane);
        startCornerStacks(pane);
    }
    if (pane._phase === 'burn') pauseClickBlasts(pane);
    else if (pane._phase === 'boom') {
        blastArm(pane, HEAT_FIRE_IN_MS, () => {
            if (pane._held && pane._phase === 'boom') blastBurn(pane);
        });
    }
}

function armPane(pane, at) {
    const preview = byId('des-preview');
    if (!pane || !pane._spec) return;
    if (preview && pane === preview._front) pane._spec = readDesignerSpec();
    pane._held = true;
    pane._at = at;
    pane._flame = at;
    if (pane._phase === 'out' || pane._phase === 'implode') {
        clearTimeout(pane._blastTimer);
        pane._blastTimer = 0;
        pane._phase = '';
        pane._frozen = false;
    }
    if (!paneShown(pane)) {
        freezePane(pane);
        return;
    }
    if (pane._frozen) {
        resumePane(pane);
        return;
    }
    if (pane._phase) return;
    if (pane._spec.randomCorners) rollBlast(pane);
    pane._cornerRoll = rollCornerStyles(pane._spec);
    if (pane._spec.mode === 'rev1') blastRev1Hold(pane);
    else if (pane._spec.stack) blastStack(pane);
    else blastExplode(pane);
}

function resetPane(pane) {
    if (!pane) return;
    clearTimeout(pane._stackTimer);
    clearTimeout(pane._cornerTimer);
    clearTimeout(pane._blastTimer);
    clearCornerStacks(pane);
    pane._held = false;
    pane._phase = '';
    pane._frozen = false;
    if (pane._spec) renderPane(pane, pane._spec);
}

function syncHeldLayers(preview) {
    if (!preview || !preview._held) return;
    const at = preview._spot || { x: 50, y: 50 };
    [preview._front, preview._back].forEach(pane => {
        if (!pane || !pane._held) return;
        if (paneShown(pane)) armPane(pane, at);
        else freezePane(pane);
    });
}

function playStage(preview, at) {
    [preview._front, preview._back].forEach(pane => armPane(pane, at));
}

function releaseStage(preview, event) {
    [preview._front, preview._back].forEach(pane => {
        if (!pane || !pane._held) return;
        if (!paneShown(pane) || !pane._phase) {
            resetPane(pane);
            return;
        }
        blastPark(pane, event);
        if (pane._spec.mode === 'rev1') blastRev1Release(pane);
        else blastImplode(pane);
    });
    preview._held = false;
}

function placeStageSpot(preview) {
    const at = preview._spot || { x: 50, y: 50 };
    [preview._front, preview._back].forEach(pane => {
        const fire = liveFire(pane);
        if (!fire) return;
        fire.querySelectorAll('.boom-click').forEach(boom => {
            boom.style.setProperty('--bx', `${at.x}%`);
            boom.style.setProperty('--by', `${at.y}%`);
        });
        placeHeatmapFire(pane, at);
    });
}

function applyFade(t) {
    const preview = byId('des-preview');
    if (!preview || !preview._front) return;
    preview._fade = t || 0;
    if (!t) {
        preview._front.style.opacity = '1';
        preview._back.style.opacity = '0';
        paintFrames();
        syncHeldLayers(preview);
        return;
    }
    const item = stageNeighbor(t > 0 ? 1 : -1);
    if (!item) return;
    if (preview._backKey !== item.key) {
        renderPane(preview._back, item.spec);
        preview._backKey = item.key;
        if (preview._held) preview._back._held = true;
    }
    const amt = Math.min(1, Math.abs(t));
    const step = amt < 0.25 ? 0 : amt < 0.75 ? 1 : 2;
    preview._front.style.opacity = step === 0 ? '1' : step === 1 ? '0.5' : '0';
    preview._back.style.opacity = step === 0 ? '0' : step === 1 ? '0.5' : '1';
    paintFrames();
    syncHeldLayers(preview);
}

function paintFrames() {
    const box = byId('stage-frames');
    const preview = byId('des-preview');
    if (!box || !preview) return;
    const fade = preview._fade || 0;
    const other = stageNeighbor(fade < 0 ? -1 : 1);
    const frames = box.querySelectorAll('span');
    frames[0].textContent = byId('des-name').value;
    frames[1].textContent = '50/50';
    frames[2].textContent = other ? other.spec.title : '';
    const amt = Math.abs(fade);
    const on = amt < 0.25 ? 0 : amt < 0.75 ? 1 : 2;
    frames.forEach((el, i) => {
        el.hidden = false;
        el.classList.toggle('on', i === on);
    });
    paintCopy();
}

function setStageRev(n) {
    const preview = byId('des-preview');
    if (!preview) return;
    preview._rev = n;
    byId('stage-rev-1').classList.toggle('on', n === 1);
    byId('stage-rev-2').classList.toggle('on', n === 2);
    if (n === 2) {
        showStage(readDesignerSpec());
        const bar = byId('stage-scroll');
        if (bar) {
            const h = bar.clientHeight;
            bar.querySelectorAll('div').forEach(el => { el.style.height = `${h}px`; });
        }
    }
    else {
        if (preview._front) preview._front.style.opacity = '1';
        if (preview._back) preview._back.style.opacity = '0';
        preview._fade = 0;
        paintCopy();
    }
}

function paintCopy() {
    const preview = byId('des-preview');
    const copy = byId('stage-copy');
    if (!preview || !copy) return;
    const bar = byId('stage-scroll');
    const frames = byId('stage-frames');
    const pair = preview._rev === 2;
    if (bar) bar.hidden = !pair;
    if (frames) frames.hidden = !pair;
    preview.classList.toggle('pair', pair);
    preview.classList.toggle('psychedelic', !!preview._psych);
    if (!pair) {
        const spec = preview._front && preview._front._spec;
        if (!spec) {
            copy.hidden = true;
            return;
        }
        copy.hidden = false;
        copy.innerHTML = `<strong>${escapeHtml(spec.title)}</strong><p>${escapeHtml(spec.text || '')}</p>`;
        return;
    }
    const fade = preview._fade || 0;
    const other = stageNeighbor(fade < 0 ? -1 : 1);
    const front = preview._front && preview._front._spec;
    const step = Math.abs(fade) < 0.25 ? 0 : Math.abs(fade) < 0.75 ? 1 : 2;
    if (step === 1) {
        if (!front || !other) return;
        copy.hidden = false;
        copy.innerHTML = `<strong>${escapeHtml(front.title)}</strong><p>${escapeHtml(front.text || '')}</p><hr class="rule"><strong>${escapeHtml(other.spec.title)}</strong><p>${escapeHtml(other.spec.text || '')}</p>`;
        const rule = copy.querySelector('.rule');
        const width = Math.max(...[...copy.querySelectorAll('p')].map(el => el.offsetWidth));
        if (rule) rule.style.width = `${width}px`;
        return;
    }
    const spec = step === 2 && other ? other.spec : front;
    if (!spec) return;
    copy.hidden = false;
    copy.innerHTML = `<strong>${escapeHtml(spec.title)}</strong><p>${escapeHtml(spec.text || '')}</p>`;
}

function commitFade(dir) {
    const preview = byId('des-preview');
    const item = stageNeighbor(dir);
    if (!item || !preview || !preview._front) return;
    if (preview._backKey !== item.key) renderPane(preview._back, item.spec);
    const front = preview._front;
    preview._front = preview._back;
    preview._back = front;
    preview._front.style.opacity = '1';
    preview._back.style.opacity = '0';
    preview._backKey = null;
    openPreset(item.key);
}

function flashList(key) {
    const enterId = String(key).startsWith('user:') ? 'user-head' : 'factory-head';
    ['factory-head', 'user-head'].forEach(id => {
        const head = byId(id);
        if (!head) return;
        head.classList.remove('blink');
        head.getAnimations().forEach(anim => anim.cancel());
        if (id !== enterId) return;
        void head.offsetWidth;
        head.classList.add('blink');
    });
}

function openPreset(key) {
    const item = catalog().find(entry => entry.key === key) || catalog()[0];
    if (!item) return;
    const crossed = openKey && openKey.startsWith('user:') !== item.key.startsWith('user:');
    openKey = item.key;
    writeDesignerSpec(item.spec);
    refreshDesigner();
    renderPresetList();
    showStage(item.spec);
    if (crossed) flashList(item.key);
}

function stepPreset(dir) {
    const items = catalog();
    if (!items.length || !dir) return;
    let index = items.findIndex(entry => entry.key === openKey);
    if (index < 0) index = 0;
    const next = ((index + dir) % items.length + items.length) % items.length;
    openPreset(items[next].key);
}

function saveCurrentPreset() {
    const spec = presetRecord(readDesignerSpec());
    const list = loadPresets().filter(item => item.title !== spec.title);
    list.push(spec);
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
    openKey = `user:${list.length - 1}`;
    renderPresetList();
    byId('preset-name').textContent = spec.title;
}

function listFrom(value) {
    if (!Array.isArray(value)) return null;
    return value.map(presetRecord).filter(Boolean);
}

function exportPresets() {
    const payload = {
        version: 2,
        factory: factoryPresets().map(presetRecord),
        user: loadPresets().map(presetRecord)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'blast-presets.json';
    link.click();
    URL.revokeObjectURL(link.href);
}

function importPresetText(raw) {
    const data = JSON.parse(raw);
    const factory = listFrom(data && data.factory);
    const user = listFrom(Array.isArray(data) ? data : data && (data.user || data.presets));
    if (!factory && !user) throw new Error('Expected preset lists');
    if (factory) localStorage.setItem(FACTORY_KEY, JSON.stringify(factory));
    if (user) localStorage.setItem(PRESET_KEY, JSON.stringify(user));
    openPreset('factory:0');
}

function paintKnobs(root) {
    (root || document).querySelectorAll('input[type="range"]').forEach(input => {
        const min = Number(input.min);
        const max = Number(input.max);
        const span = max - min || 1;
        input.style.setProperty('--knob', String((Number(input.value) - min) / span));
    });
}

function wireKnobs() {
    const rack = byId('blast-designer');
    rack.addEventListener('pointerdown', event => {
        const input = event.target.closest('input[type="range"]');
        if (!input) return;
        event.preventDefault();
        input.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const start = Number(input.value);
        const min = Number(input.min);
        const max = Number(input.max);
        const step = Number(input.step) || (max - min) / 100;
        const move = ev => {
            const next = start + ((startY - ev.clientY) / 110) * (max - min);
            const stepped = Math.round(next / step) * step;
            input.value = String(Math.min(max, Math.max(min, Number(stepped.toFixed(4)))));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const stop = () => {
            input.removeEventListener('pointermove', move);
            input.removeEventListener('pointerup', stop);
            input.removeEventListener('pointercancel', stop);
        };
        input.addEventListener('pointermove', move);
        input.addEventListener('pointerup', stop);
        input.addEventListener('pointercancel', stop);
    });
}

function wireSplitters() {
    const workspace = byId('workspace');
    const drag = (handle, move) => {
        handle.onpointerdown = event => {
            event.preventDefault();
            const onMove = ev => move(ev);
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        };
    };
    drag(byId('split-browser'), event => {
        const width = Math.min(480, Math.max(160, event.clientX - workspace.getBoundingClientRect().left));
        workspace.style.setProperty('--browser-w', `${width}px`);
    });
    drag(byId('split-device'), event => {
        const main = document.querySelector('.mainview');
        const height = Math.min(520, Math.max(120, main.getBoundingClientRect().bottom - event.clientY));
        main.style.setProperty('--device-h', `${height}px`);
    });
}

function wireDesigner() {
    const click = byId('des-click');
    if (!click) return;
    fillKindSelect(click);
    click.value = 'cartoon';
    document.querySelectorAll('.des-corner').forEach(el => fillKindSelect(el, true));
    fillKindSelect(byId('des-corner-one'), true);
    byId('des-on').onclick = () => {
        const on = byId('des-on').getAttribute('aria-pressed') === 'false';
        setDeviceOn(on);
        if (!on && blastLive) blastImplode(blastLive);
        refreshDesigner();
    };
    byId('blast-designer').addEventListener('contextmenu', event => {
        const host = event.target.closest('[data-lfo]');
        if (!host) return;
        event.preventDefault();
        const lfos = readLfoDevices();
        lfos.push({ on: true, target: host.dataset.lfo, rate: 0.4, depth: 0.5 });
        writeLfoDevices(lfos);
        refreshDesigner();
    });
    byId('dev-chain').addEventListener('input', event => {
        if (event.target.closest('.lfo-device')) refreshDesigner();
    });
    const preview = byId('des-preview');
    preview.innerHTML = '<div class="stage-pane" id="stage-a"></div><div class="stage-pane" id="stage-b"></div><div class="k"></div><div class="v"></div><div id="stage-copy" class="stage-copy" hidden></div><div id="stage-frames" class="stage-frames"><span></span><span>50/50</span><span></span></div><div class="stage-scroll" id="stage-scroll"><div></div><div></div><div></div></div>';
    preview._rev = 1;
    preview._front = byId('stage-a');
    preview._back = byId('stage-b');
    bindBlastCard(preview);
    preview.addEventListener('pointermove', event => {
        const at = heatClickPoint(preview, event);
        if (!at) return;
        preview._spot = at;
        placeStageSpot(preview);
    });
    preview.addEventListener('wheel', event => {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
        const dy = event.deltaY * scale;
        const dx = event.deltaX * scale;
        const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
        preview._wheelDebt = (preview._wheelDebt || 0) + delta;
        if (preview._held) {
            clearTimeout(preview._stackTimer);
            clearTimeout(preview._cornerTimer);
            releaseStage(preview, event);
            preview._phase = '';
            if (blastLive === preview) blastLive = null;
        }
        if (preview._rev !== 2) {
            while (preview._wheelDebt >= 100) {
                preview._wheelDebt -= 100;
                stepPreset(1);
            }
            while (preview._wheelDebt <= -100) {
                preview._wheelDebt += 100;
                stepPreset(-1);
            }
            return;
        }
        while (preview._wheelDebt >= 100) {
            preview._wheelDebt -= 100;
            nudgeStage(1);
        }
        while (preview._wheelDebt <= -100) {
            preview._wheelDebt += 100;
            nudgeStage(-1);
        }
    }, { passive: false });
    byId('blast-designer').addEventListener('click', event => {
        const remove = event.target.closest('[data-remove]');
        if (remove) {
            const lfos = readLfoDevices();
            lfos.splice(Number(remove.dataset.remove), 1);
            writeLfoDevices(lfos);
            refreshDesigner();
            return;
        }
        const fold = event.target.closest('.fold');
        if (!fold) return;
        const dev = fold.closest('.device, .lfo-device');
        if (!dev) return;
        const folded = dev.classList.toggle('folded');
        fold.setAttribute('aria-expanded', folded ? 'false' : 'true');
    });
    ['des-flames', 'des-flames-on', 'des-speed', 'des-link-speed', 'des-link-size', 'des-click-speed', 'des-size', 'des-click-size', 'des-flame-size', 'des-gap', 'des-name', 'des-click', 'des-click-on', 'des-spin', 'des-stack', 'des-corner-one', 'des-corner-loop'].forEach(id => {
        byId(id).oninput = refreshDesigner;
    });
    document.querySelectorAll('.des-corner, .corner-size, .corner-speed, .corner-delay, .corner-on, .corner-stack').forEach(el => { el.oninput = refreshDesigner; });
    const chain = byId('dev-chain');
    let dragDev = null;
    chain.addEventListener('pointerdown', event => {
        const head = event.target.closest('.device-head');
        const dev = head && head.closest('[data-layer]');
        if (!dev || event.target.closest('button, input, select')) return;
        dragDev = dev;
        dev.classList.add('dragging');
        event.preventDefault();
    });
    window.addEventListener('pointermove', event => {
        if (!dragDev) return;
        const hit = [...document.elementsFromPoint(event.clientX, event.clientY)].map(el => el.closest && el.closest('[data-layer]')).find(el => el && el !== dragDev);
        if (!hit) return;
        const box = hit.getBoundingClientRect();
        chain.insertBefore(dragDev, event.clientX > box.left + box.width / 2 ? hit.nextSibling : hit);
    });
    window.addEventListener('pointerup', () => {
        if (!dragDev) return;
        dragDev.classList.remove('dragging');
        dragDev = null;
        refreshDesigner();
    });
    ['des-corners', 'des-pattern', 'des-overlap'].forEach(id => { byId(id).onchange = refreshDesigner; });
    byId('des-inset').onchange = () => {
        refreshDesigner();
        showStage(readDesignerSpec());
    };
    byId('des-save').onclick = saveCurrentPreset;
    byId('des-export').onclick = exportPresets;
    byId('stage-rev-1').onclick = () => setStageRev(1);
    byId('stage-rev-2').onclick = () => setStageRev(2);
    byId('stage-psych').onclick = () => {
        const preview = byId('des-preview');
        preview._psych = !preview._psych;
        byId('stage-psych').classList.toggle('on', preview._psych);
        paintCopy();
    };
    setStageRev(1);
    byId('preset-prev').onclick = () => stepPreset(-1);
    byId('preset-next').onclick = () => stepPreset(1);
    document.querySelector('.browser').onclick = event => {
        const row = event.target.closest('[data-key]');
        if (row) openPreset(row.dataset.key);
    };
    byId('des-import').onchange = () => {
        const file = byId('des-import').files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try { importPresetText(reader.result); }
            catch (err) { byId('des-preview').querySelector('.v').textContent = 'That JSON could not be imported.'; }
        };
        reader.readAsText(file);
        byId('des-import').value = '';
    };
    openPreset('factory:0');
    wireSplitters();
    wireKnobs();
    const stageBar = byId('stage-scroll');
    const sizeStageBar = () => {
        const h = stageBar.clientHeight;
        stageBar.querySelectorAll('div').forEach(el => { el.style.height = `${h}px`; });
    };
    sizeStageBar();
    stageBar.addEventListener('scroll', syncStageScroll);
    if (window.ResizeObserver) new ResizeObserver(() => { syncStage(preview); sizeStageBar(); }).observe(preview);
    syncStage(preview);
}

function renderBlastLab() {
    wireDesigner();
    requestAnimationFrame(tickLfos);
    if (!window._blastHoldBound) {
        window._blastHoldBound = true;
        const release = event => {
            if (!blastLive || !blastLive._held) return;
            if (blastLive.id === 'des-preview' && blastLive._front) {
                releaseStage(blastLive, event);
                return;
            }
            blastPark(blastLive, event);
            if (blastLive._spec.mode === 'rev1') blastRev1Release(blastLive);
            else blastImplode(blastLive);
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        window.addEventListener('pointermove', event => {
            const card = blastLive;
            if (!card || !card._held) return;
            if (card.id === 'des-preview' && card._front) {
            const at = heatClickPoint(card, event);
            if (!at) return;
                card._spot = at;
                [card._front, card._back].forEach(pane => {
                    if (!pane || !pane._held || pane._spec.mode === 'rev1') return;
                    pane._at = at;
                    pane._flame = at;
                    const fire = liveFire(pane);
                    if (fire) fire.querySelectorAll('.boom-click').forEach(boom => {
                        boom.style.setProperty('--bx', `${at.x}%`);
                        boom.style.setProperty('--by', `${at.y}%`);
                    });
                    if (pane._phase === 'burn') placeHeatmapFire(pane, at);
                });
                return;
            }
            if (card._spec.mode === 'rev1') return;
            const at = heatClickPoint(card, event);
            if (!at) return;
            card._at = at;
            card._flame = at;
            const fire = liveFire(card);
            if (fire) fire.querySelectorAll('.boom-click').forEach(boom => {
                boom.style.setProperty('--bx', `${at.x}%`);
                boom.style.setProperty('--by', `${at.y}%`);
            });
            if (card._phase === 'burn') placeHeatmapFire(card, at);
        });
    }
}

renderBlastLab();
