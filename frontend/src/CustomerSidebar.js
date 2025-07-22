import React from 'react';
import { FaShopify } from 'react-icons/fa';
import { HiChatBubbleLeftRight } from 'react-icons/hi2';

export default function Sidebar({
  selectedSection,
  onSectionChange,
  unreadChats = 0,         // Pass unread count as a prop!
  unrespondedChats = 0     // Optionally, unresponded count
}) {
  return (
    <div className="w-56 bg-gray-800 border-r border-gray-700 text-white h-full flex flex-col">
      <div className="p-4 text-lg font-bold border-b border-gray-700">
        <span className="tracking-wide">Inbox Dashboard</span>
      </div>
      <ul className="flex-1">
        <li>
          <button
            className={`w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-gray-700 
              ${selectedSection === 'chats' ? 'bg-[#004AAD] text-white' : ''}`}
            onClick={() => onSectionChange('chats')}
          >
            <HiChatBubbleLeftRight className="inline text-xl" />
            <span>Chats</span>
            {/* Show unread badge if > 0 */}
            {unreadChats > 0 && (
              <span className="ml-auto bg-red-500 text-xs px-2 py-0.5 rounded-full text-white">
                {unreadChats}
              </span>
            )}
            {/* Show unresponded badge if > 0 */}
            {unrespondedChats > 0 && (
              <span className="ml-2 bg-yellow-400 text-xs px-2 py-0.5 rounded-full text-gray-800">
                {unrespondedChats}
              </span>
            )}
          </button>
        </li>
        <li>
          <button
            className={`w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-gray-700 
              ${selectedSection === 'shopify' ? 'bg-green-800' : ''}`}
            onClick={() => onSectionChange('shopify')}
          >
            <FaShopify className="inline text-xl text-green-400" />
            <span>Shopify Integrations</span>
          </button>
        </li>
        {/* Future: Add more sections here */}
      </ul>
      {/* (Optional) Footer area */}
      <div className="p-4 border-t border-gray-700 text-xs text-gray-400">
        <span>© {new Date().getFullYear()} Your Company</span>
      </div>
    </div>
  );
}
