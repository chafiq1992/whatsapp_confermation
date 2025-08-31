import React from 'react';
import { HiChatBubbleLeftRight, HiInboxArrowDown, HiArchiveBox, HiCog6Tooth } from 'react-icons/hi2';
import { FaRobot } from 'react-icons/fa';

export default function MiniSidebar({
	showArchive = false,
	onSetShowArchive,
	onToggleInternal,
	onOpenSettings,
	onOpenAutomation,
}) {
	return (
		<div className="w-16 bg-gray-900 border-r border-gray-800 h-full flex flex-col items-center justify-between py-3">
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
					onClick={() => onToggleInternal && onToggleInternal()}
					className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-gray-800 text-gray-300 hover:bg-gray-700"
				>
					<HiChatBubbleLeftRight />
				</button>
			</div>

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


