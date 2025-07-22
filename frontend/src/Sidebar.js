import React from 'react';
import { FaShopify } from 'react-icons/fa';

export default function Sidebar({ selectedSection, onSectionChange }) {
  return (
    <div className="w-56 bg-gray-800 border-r border-gray-700 text-white h-full flex flex-col">
      <div className="p-4 text-lg font-bold border-b border-gray-700">App Sidebar</div>
      <ul>
        <li>
          <button
            className={`w-full px-4 py-2 text-left hover:bg-gray-700 ${selectedSection === 'chats' ? 'bg-gray-700' : ''}`}
            onClick={() => onSectionChange('chats')}
          >💬 Chats</button>
        </li>
        <li>
          <button
            className={`w-full px-4 py-2 text-left hover:bg-gray-700 ${selectedSection === 'shopify' ? 'bg-green-800' : ''}`}
            onClick={() => onSectionChange('shopify')}
          ><FaShopify className="inline mr-2 text-green-400" />Shopify Integrations</button>
        </li>
      </ul>
    </div>
  );
}