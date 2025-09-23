import React, { useEffect, useRef, useState } from 'react';
import { HiChatBubbleLeftRight, HiInboxArrowDown, HiArchiveBox, HiCog6Tooth, HiUserCircle } from 'react-icons/hi2';
import { FaRobot } from 'react-icons/fa';
import api from './api';

export default function MiniSidebar({
	showArchive = false,
	onSetShowArchive,
	onToggleInternal,
	onSelectInternalAgent,
	onOpenSettings,
	onOpenAutomation,
  currentAgent = '',
}) {
	const [showDropdown, setShowDropdown] = useState(false);
	const [agents, setAgents] = useState([]);
	const buttonRef = useRef(null);
	const dropdownRef = useRef(null);

	useEffect(() => {
		(async () => {
			try {
				const res = await api.get('/admin/agents');
				setAgents(res.data || []);
			} catch {}
		})();
	}, []);

	useEffect(() => {
		const handler = (e) => {
			if (!showDropdown) return;
			const t = e.target;
			if (!dropdownRef.current || !buttonRef.current) return;
			if (!dropdownRef.current.contains(t) && !buttonRef.current.contains(t)) {
				setShowDropdown(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [showDropdown]);

	// Resolve display name for current agent (prefer friendly name if available)
	const displayName = (() => {
		try {
			const a = agents.find(x => String(x.username || '').toLowerCase() === String(currentAgent || '').toLowerCase());
			return (a?.name || currentAgent || '').toString();
		} catch { return currentAgent || ''; }
	})();

	return (
		<div className="w-16 bg-gray-900 border-r border-gray-800 h-full flex flex-col items-center justify-between py-3 relative">
			{/* Upper section */}
			<div className="flex flex-col items-center gap-3">
				<button
					type="button"
					title="Inbox"
					onClick={() => onSetShowArchive && onSetShowArchive(false)}
					className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl transition-colors ${!showArchive ? 'bg-[#004AAD] text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
				>
					<HiInboxArrowDown />
				</button>
				<button
					type="button"
					title="Archive"
					onClick={() => onSetShowArchive && onSetShowArchive(true)}
					className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl transition-colors ${showArchive ? 'bg-[#004AAD] text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
				>
					<HiArchiveBox />
				</button>
				<button
					type="button"
					title="Internal chats"
					onClick={() => {
						setShowDropdown(v => !v);
						if (onToggleInternal) onToggleInternal();
					}}
					className="w-14 h-14 rounded-xl flex items-center justify-center text-3xl bg-gray-800 text-gray-300 hover:bg-gray-700"
					ref={buttonRef}
				>
					<HiChatBubbleLeftRight />
				</button>
				{showDropdown && (
					<div ref={dropdownRef} className="absolute left-16 top-16 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 w-64 max-h-72 overflow-auto">
						<div className="p-2 text-sm text-gray-300 border-b border-gray-800 sticky top-0 bg-gray-900">Internal chats</div>
						<div className="p-1">
							{agents.map(a => (
								<button
									key={a.username}
									type="button"
									onClick={() => {
										if (onSelectInternalAgent) onSelectInternalAgent(a.username);
										setShowDropdown(false);
									}}
									className="w-full flex items-center gap-2 px-2 py-2 hover:bg-gray-800 rounded text-left"
									title={`DM @${a.name || a.username}`}
								>
									<HiUserCircle className="text-2xl" />
									<span className="truncate">@{a.name || a.username}</span>
								</button>
							))}
							{agents.length === 0 && (
								<div className="text-sm text-gray-400 px-2 py-2">No agents</div>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Agent name (vertical, carved effect) */}
			{(displayName && displayName.trim()) && (
				<div className="flex-1 flex items-center justify-center select-none">
					<div className="flex flex-col items-center" aria-label="agent-name">
						{displayName.toUpperCase().split('').map((ch, i) => (
							<div
								key={i}
								className="text-gray-300 font-extrabold"
								style={{
									fontSize: '20px',
									letterSpacing: '0.1em',
									lineHeight: '22px',
									textShadow: '0 1px 0 rgba(255,255,255,0.14), 0 -1px 0 rgba(0,0,0,0.65), 0 2px 6px rgba(0,0,0,0.6)'
								}}
							>
								{ch}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Lower section */}
			<div className="flex flex-col items-center gap-3">
				<button
					type="button"
					title="Automation"
					onClick={() => onOpenAutomation && onOpenAutomation()}
					className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-gray-800 text-gray-300 hover:bg-gray-700"
				>
					<FaRobot />
				</button>
				<button
					type="button"
					title="Settings"
					onClick={() => onOpenSettings && onOpenSettings()}
					className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-gray-800 text-gray-300 hover:bg-gray-700"
				>
					<HiCog6Tooth />
				</button>
			</div>
		</div>
	);
}


