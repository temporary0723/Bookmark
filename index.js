// 북마크 매니저 확장 - SillyTavern Extension
// 채팅 메시지에 북마크를 추가하고 관리할 수 있는 기능 제공

import {
    eventSource,
    event_types,
    chat,
    getRequestHeaders,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';

import {
    getContext,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

import {
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

import {
    uuidv4,
    timestampToMoment,
} from '../../../utils.js';

// 확장 이름 및 상수 정의
const pluginName = 'bookmark-manager';
const extensionFolderPath = `scripts/extensions/third-party/Bookmark`;

// 채팅별 북마크 저장을 위한 메타데이터 키
const BOOKMARK_METADATA_KEY = 'bookmarks_v2';

// 메시지 버튼 HTML (북마크 아이콘)
const messageButtonHtml = `
    <div class="mes_button bookmark-icon interactable" title="책갈피 추가" tabindex="0">
        <i class="fa-solid fa-bookmark"></i>
    </div>
`;

// 북마크 데이터 저장소
let bookmarks = [];

// 현재 열린 모달
let currentModal = null;

// Extension Settings에 북마크 인덱스 초기화
function initializeBookmarkIndex() {
    if (!extension_settings[pluginName]) {
        extension_settings[pluginName] = {
            bookmarkIndex: {},
            version: '1.0'
        };
        saveSettingsDebounced();
    }
    
    // 기존 설정에 bookmarkIndex가 없으면 추가
    if (!extension_settings[pluginName].bookmarkIndex) {
        extension_settings[pluginName].bookmarkIndex = {};
        saveSettingsDebounced();
    }
}

// 북마크 인덱스 업데이트
function updateBookmarkIndex(characterId, chatId, bookmarkCount) {
    if (characterId === undefined || chatId === undefined) {
        return;
    }
    
    initializeBookmarkIndex();
    
    const characterKey = characterId.toString();
    const chatKey = chatId.toString();
    
    if (!extension_settings[pluginName].bookmarkIndex[characterKey]) {
        extension_settings[pluginName].bookmarkIndex[characterKey] = {};
    }
    
    if (bookmarkCount > 0) {
        extension_settings[pluginName].bookmarkIndex[characterKey][chatKey] = {
            count: bookmarkCount,
            lastUpdated: new Date().toISOString()
        };
    } else {
        // 책갈피가 없으면 인덱스에서 제거
        delete extension_settings[pluginName].bookmarkIndex[characterKey][chatKey];
        
        // 캐릭터에 채팅이 없으면 캐릭터도 제거
        if (Object.keys(extension_settings[pluginName].bookmarkIndex[characterKey]).length === 0) {
            delete extension_settings[pluginName].bookmarkIndex[characterKey];
        }
    }
    
    saveSettingsDebounced();

}

// 북마크 인덱스 조회
function getBookmarkIndex() {
    initializeBookmarkIndex();
    return extension_settings[pluginName].bookmarkIndex || {};
}

// 빠른 전체 북마크 요약 정보
function getBookmarkIndexSummary() {
    const index = getBookmarkIndex();
    const summary = {
        totalCharacters: Object.keys(index).length,
        totalChats: 0,
        totalBookmarks: 0,
        characterList: []
    };
    
    for (const [characterId, chats] of Object.entries(index)) {
        const chatCount = Object.keys(chats).length;
        const bookmarkCount = Object.values(chats).reduce((sum, chat) => sum + chat.count, 0);
        
        summary.totalChats += chatCount;
        summary.totalBookmarks += bookmarkCount;
        summary.characterList.push({
            characterId: parseInt(characterId),
            chatCount,
            bookmarkCount
        });
    }
    
    return summary;
}

/**
 * 모든 캐릭터의 북마크 데이터 완전 삭제 (위험한 기능)
 */
async function deleteAllBookmarksFromAllCharacters() {
    try {
        // 첫 번째 확인: 기본 경고
        const firstConfirm = await callGenericPopup(
            '⚠️ 위험한 작업 ⚠️\n\n모든 캐릭터의 모든 채팅에서 책갈피를 완전히 삭제합니다.\n이 작업은 되돌릴 수 없습니다!\n\n계속하시겠습니까?',
            POPUP_TYPE.CONFIRM
        );
        
        if (firstConfirm !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        
        // 삭제 진행
        toastr.info('모든 캐릭터의 책갈피를 삭제하고 있습니다...');
        
        const context = getContext();
        if (!context || !context.characters || !Array.isArray(context.characters)) {
            toastr.error('캐릭터 목록을 찾을 수 없습니다.');
            return;
        }
        
        const bookmarkIndex = getBookmarkIndex();
        let deletedCharacters = 0;
        let deletedChats = 0;
        let totalErrors = 0;
        
        // 먼저 현재 채팅의 책갈피를 즉시 삭제하고 모달 업데이트
        let currentChatProcessed = false;
        if (context.characterId !== undefined && context.chatId !== undefined) {
            const currentCharacterKey = context.characterId.toString();
            const currentChatKey = context.chatId.toString();
            
            // 현재 채팅에 책갈피가 있는지 확인
            if (bookmarkIndex[currentCharacterKey] && bookmarkIndex[currentCharacterKey][currentChatKey]) {
                bookmarks.length = 0; // 메모리에서 즉시 삭제
                saveBookmarks(); // 인덱스도 자동으로 업데이트됨
                deletedChats++;
                currentChatProcessed = true;
                
                // 현재 채팅 삭제 후 즉시 모달 업데이트
                refreshBookmarkListInModal();
                toastr.info('현재 채팅의 책갈피가 삭제되었습니다. 다른 채팅들을 처리하고 있습니다...');
            }
        }
        
        // 인덱스에 있는 모든 캐릭터의 북마크 삭제
        for (const [characterIdStr, characterChats] of Object.entries(bookmarkIndex)) {
            const charIndex = parseInt(characterIdStr);
            const character = context.characters[charIndex];
            
            if (!character || !character.name || !character.avatar) {
                continue;
            }
            
            for (const [chatId] of Object.entries(characterChats)) {
                try {
                    // 현재 캐릭터의 현재 채팅인 경우 (이미 처리되었으면 건너뛰기)
                    if (charIndex === context.characterId && chatId === context.chatId && currentChatProcessed) {
                        continue; // 이미 처리했으므로 건너뛰기
                    }
                    
                    // 현재 채팅이지만 위에서 처리되지 않은 경우 (안전장치)
                    if (charIndex === context.characterId && chatId === context.chatId) {
                        // 메모리에서 삭제
                        bookmarks.length = 0;
                        saveBookmarks(); // 인덱스도 자동으로 업데이트됨
                        deletedChats++;
                        continue;
                    }
                    
                    // 다른 채팅의 메타데이터에서 북마크 삭제
                    const chatRequestBody = {
                        ch_name: character.name,
                        file_name: chatId.replace('.jsonl', ''),
                        avatar_url: character.avatar
                    };
                    
                    const chatResponse = await fetch('/api/chats/get', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify(chatRequestBody)
                    });
                    
                    if (!chatResponse.ok) {
                        totalErrors++;
                        continue;
                    }
                    
                    const chatData = await chatResponse.json();
                    
                    if (!Array.isArray(chatData) || chatData.length === 0) {
                        totalErrors++;
                        continue;
                    }
                    
                    // 메타데이터에서 북마크 제거
                    const firstItem = chatData[0];
                    if (typeof firstItem === 'object' && firstItem !== null) {
                        const chatMetadata = firstItem.chat_metadata || firstItem;
                        
                        // 북마크가 있는 경우에만 삭제 진행
                        if (chatMetadata[BOOKMARK_METADATA_KEY]) {
                            delete chatMetadata[BOOKMARK_METADATA_KEY];
                            
                            // 업데이트된 채팅 데이터 구성
                            const updatedFirstItem = {
                                ...firstItem,
                                chat_metadata: chatMetadata
                            };
                            
                            const updatedChatData = [updatedFirstItem, ...chatData.slice(1)];
                            
                            // 서버에 저장
                            const saveRequestBody = {
                                ch_name: character.name,
                                file_name: chatId.replace('.jsonl', ''),
                                avatar_url: character.avatar,
                                chat: updatedChatData,
                                force: true
                            };
                            
                            const saveResponse = await fetch('/api/chats/save', {
                                method: 'POST',
                                headers: getRequestHeaders(),
                                body: JSON.stringify(saveRequestBody)
                            });
                            
                            if (!saveResponse.ok) {
                                console.error(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 저장 실패`);
                                totalErrors++;
                            } else {
                                deletedChats++;
                            }
                        }
                    }
                    
                } catch (error) {
                    console.error(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 삭제 중 오류:`, error);
                    totalErrors++;
                }
            }
            
            deletedCharacters++;
        }
        
        // 인덱스 완전 초기화
        extension_settings[pluginName].bookmarkIndex = {};
        saveSettingsDebounced();
        
        // UI 새로고침
        refreshBookmarkIcons();
        
        if (totalErrors === 0) {
            toastr.success(`모든 책갈피 삭제 완료!\n• ${deletedCharacters}개 캐릭터\n• ${deletedChats}개 채팅에서 책갈피가 삭제되었습니다.`);
        } else {
            toastr.warning(`책갈피 삭제 완료 (일부 오류 발생)\n• ${deletedCharacters}개 캐릭터\n• ${deletedChats}개 채팅에서 삭제 성공\n• ${totalErrors}개 오류 발생`);
        }
        
        // 모달 새로고침
        refreshBookmarkListInModal();
        
    } catch (error) {
        console.error('[Bookmark] 전체 삭제 중 오류:', error);
        toastr.error('전체 삭제 중 오류가 발생했습니다.');
    }
}

/**
 * 현재 채팅의 메타데이터에서 북마크 로드
 */
function loadBookmarks() {
    try {
        const context = getContext();
        if (!context || !context.chatMetadata) {
            
            bookmarks = [];
            return;
        }

        const savedBookmarks = context.chatMetadata[BOOKMARK_METADATA_KEY];
        
        if (savedBookmarks && Array.isArray(savedBookmarks)) {
            bookmarks = savedBookmarks;
        } else {
            bookmarks = [];
        }
    } catch (error) {
        console.error('북마크 로드 실패:', error);
        bookmarks = [];
    }
}

/**
 * 현재 채팅의 메타데이터에 북마크 저장
 */
function saveBookmarks() {
    try {
        const context = getContext();
        if (!context || !context.chatMetadata) {
            console.error('[Bookmark] 컨텍스트 또는 메타데이터를 찾을 수 없어 책갈피를 저장할 수 없습니다.');
            return;
        }

        // 메타데이터에 북마크 저장
        context.chatMetadata[BOOKMARK_METADATA_KEY] = [...bookmarks];
        
        // 메타데이터 변경사항 저장
        saveMetadataDebounced();
        
        // 인덱스 업데이트
        updateBookmarkIndex(context.characterId, context.chatId, bookmarks.length);
        
    } catch (error) {
        console.error('책갈피 저장 실패:', error);
    }
}

/**
 * 메시지 ID로 이동 (SillyTavern 공식 명령어 사용)
 */
async function jumpToMessage(messageId) {
    try {
    
        const chatInput = $('#send_textarea');
        if (chatInput.length === 0) {
            toastr.error('채팅 입력창을 찾을 수 없습니다.');
            return;
        }

        // 기존 입력 내용 백업
        const originalText = chatInput.val();
        
        // /chat-jump 명령어 실행
        const jumpCommand = `/chat-jump ${messageId}`;
        chatInput.val(jumpCommand);
        chatInput.trigger('input');
        
        setTimeout(() => {
            $('#send_but').click();
            
            // 명령어 실행 후 원래 텍스트 복원
            setTimeout(() => {
                chatInput.val(originalText || '');
                chatInput.trigger('input');
            
                // 이동 후 해당 메시지 강조 (약간의 지연 후)
                setTimeout(() => {
                    highlightMessage(messageId);
                }, 1000);
            }, 500);
        }, 100);
        
        toastr.success(`메시지 #${messageId}로 이동합니다.`);
        
    } catch (error) {
        console.error('[Bookmark] 메시지 이동 중 오류:', error);
        toastr.error('메시지 이동 중 오류가 발생했습니다.');
    }
}

/**
 * 메시지 강조 효과
 */
function highlightMessage(messageId) {
    try {
        const messageElement = $(`.mes[mesid="${messageId}"]`);
        if (messageElement.length > 0) {
            messageElement.addClass('highlight-bookmark');
            setTimeout(() => {
                messageElement.removeClass('highlight-bookmark');
            }, 3000);
    
        }
    } catch (error) {
    }
}

/**
 * 북마크 해제 확인 모달
 */
async function showBookmarkRemoveConfirm(messageId) {

    const bookmark = bookmarks.find(b => b.messageId === parseInt(messageId));
    const bookmarkName = bookmark ? bookmark.name : `메시지 #${messageId}`;
    
    const result = await callGenericPopup(
        `책갈피 "${bookmarkName}"를 삭제하시겠습니까?`,
        POPUP_TYPE.CONFIRM
    );
    
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // 북마크 삭제
        const bookmarkIndex = bookmarks.findIndex(b => b.messageId === parseInt(messageId));
        if (bookmarkIndex !== -1) {
            const deletedBookmark = bookmarks.splice(bookmarkIndex, 1)[0];
            saveBookmarks();
            refreshBookmarkIcons();
            refreshBookmarkListInModal(); // 모달이 열려있으면 새로고침
            toastr.success(`책갈피 "${deletedBookmark.name}"가 삭제되었습니다.`);
    
        }
    }
}

/**
 * 북마크 추가 모달 생성
 */
async function createBookmarkModal(messageId) {

    const result = await callGenericPopup(
        '책갈피 제목을 입력하세요',
        POPUP_TYPE.INPUT,
        ''
    );
    
    if (result && result.trim()) {
        const bookmarkName = result.trim();
        
        // 북마크 추가 (설명은 빈 문자열로)
        addBookmark(messageId, bookmarkName, '');
        
        // 북마크 상태 새로고침
        setTimeout(() => {
            refreshBookmarkIcons();
            refreshBookmarkListInModal(); // 모달이 열려있으면 새로고침
        }, 100);
        
        toastr.success('책갈피가 추가되었습니다.');
    } else {

    }
}

/**
 * 북마크 모달 닫기 (더 이상 사용하지 않음)
 */
function closeBookmarkModal() {
    // SillyTavern 기본 모달 사용으로 인해 더 이상 필요 없음

}

/**
 * 북마크 추가
 */
function addBookmark(messageId, name, description) {

    const bookmark = {
        id: uuidv4(),
        messageId: parseInt(messageId),
        name: name,
        description: description,
        createdAt: new Date().toISOString()
    };

    bookmarks.push(bookmark);
    bookmarks.sort((a, b) => a.messageId - b.messageId);
    
    saveBookmarks();

}

/**
 * 북마크 수정
 */
function editBookmark(bookmarkId, name, description) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (bookmark) {
        bookmark.name = name;
        bookmark.description = description;
        saveBookmarks();
    }
}

/**
 * 북마크 삭제
 */
function deleteBookmark(bookmarkId) {
    const index = bookmarks.findIndex(b => b.id === bookmarkId);
    if (index !== -1) {
        bookmarks.splice(index, 1);
        saveBookmarks(); // 이 함수에서 인덱스도 자동으로 업데이트됨
    }
}

/**
 * 현재 모달의 북마크 리스트만 새로고침
 */
function refreshBookmarkListInModal() {
    if (!currentModal || currentModal.length === 0) {
        return; // 모달이 열려있지 않으면 아무것도 하지 않음
    }
    
    // 새로운 북마크 리스트 HTML 생성
    const bookmarkList = bookmarks.map(bookmark => `
        <div class="bookmark-item" data-bookmark-id="${bookmark.id}">
            <div class="bookmark-content" data-message-id="${bookmark.messageId}">
                <div class="bookmark-id">#${bookmark.messageId}</div>
                <div class="bookmark-name">${bookmark.name}</div>
                <input type="text" class="bookmark-description-field text_pole" value="${bookmark.description || ''}" placeholder="책갈피 설명을 입력하세요" data-bookmark-id="${bookmark.id}">
            </div>
            <div class="bookmark-actions">
                <button class="bookmark-edit-btn" title="수정">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="bookmark-delete-btn" title="삭제">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
    
    // 모달 바디 업데이트
    const modalBody = currentModal.find('.bookmark-modal-body');
    const dataControls = modalBody.find('.bookmark-data-controls');
    
    if (bookmarks.length === 0) {
        modalBody.html(`
            <div class="no-bookmarks">저장된 책갈피가 없습니다.</div>
            ${dataControls[0].outerHTML}
        `);
    } else {
        modalBody.html(`
            <div class="bookmark-list">${bookmarkList}</div>
            ${dataControls[0].outerHTML}
        `);
    }
    
    // 이벤트 핸들러 다시 바인딩
    bindModalEventHandlers();
}

/**
 * 모달 이벤트 핸들러 바인딩
 */
function bindModalEventHandlers() {
    if (!currentModal) return;
    
    // 북마크 클릭으로 메시지 이동
    currentModal.find('.bookmark-content').off('click').on('click', function() {
        const messageId = $(this).data('message-id');
        
        // 모달 닫기
        currentModal.removeClass('visible');
        currentModal.find('.bookmark-list-modal').removeClass('visible');
        
        setTimeout(() => {
            currentModal.remove();
            currentModal = null;
            
            // 메시지로 이동
            jumpToMessage(messageId);
        }, 300);
    });

    // 설명 필드 변경 이벤트
    currentModal.find('.bookmark-description-field').off('blur').on('blur', function() {
        const bookmarkId = $(this).data('bookmark-id');
        const newDescription = $(this).val().trim();
        const bookmark = bookmarks.find(b => b.id === bookmarkId);
        
        if (bookmark && bookmark.description !== newDescription) {
            bookmark.description = newDescription;
            saveBookmarks();
    
        }
    });

    // 설명 필드 클릭 시 이동 방지
    currentModal.find('.bookmark-description-field').off('click').on('click', function(e) {
        e.stopPropagation();
    });



    // 전체 삭제 버튼 이벤트
    currentModal.find('.bookmark-delete-all-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        deleteAllBookmarksFromAllCharacters();
    });

    // 수정 버튼 (이름만 수정)
    currentModal.find('.bookmark-edit-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        editBookmarkNameOnly(bookmarkId);
    });

    // 삭제 버튼
    currentModal.find('.bookmark-delete-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        confirmDeleteBookmark(bookmarkId);
    });
}

/**
 * 북마크 목록 모달 생성
 */
async function createBookmarkListModal() {
    const bookmarkList = bookmarks.map(bookmark => `
        <div class="bookmark-item" data-bookmark-id="${bookmark.id}">
            <div class="bookmark-content" data-message-id="${bookmark.messageId}">
                <div class="bookmark-id">#${bookmark.messageId}</div>
                <div class="bookmark-name">${bookmark.name}</div>
                <input type="text" class="bookmark-description-field text_pole" value="${bookmark.description || ''}" placeholder="책갈피 설명을 입력하세요" data-bookmark-id="${bookmark.id}">
            </div>
            <div class="bookmark-actions">
                <button class="bookmark-edit-btn" title="수정">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="bookmark-delete-btn" title="삭제">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');

    const modalHtml = `
        <div class="bookmark-list-modal-backdrop">
            <div class="bookmark-list-modal">
                <div class="bookmark-modal-header">
                    <h3>책갈피 목록</h3>
                    <button class="bookmark-modal-close" title="닫기">×</button>
                </div>
                <div class="bookmark-modal-body">
                    ${bookmarks.length === 0 
                        ? '<div class="no-bookmarks">저장된 책갈피가 없습니다.</div>' 
                        : `<div class="bookmark-list">${bookmarkList}</div>`
                    }
                    <div class="bookmark-data-controls">
                        <button class="bookmark-delete-all-btn" title="모든 캐릭터의 책갈피 완전 삭제">
                            <i class="fa-solid fa-trash-can"></i>
                            <span>전체 삭제</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 기존 모달 제거
    if (currentModal) {
        currentModal.remove();
    }

    currentModal = $(modalHtml);
    $('body').append(currentModal);

    // 애니메이션 효과
    setTimeout(() => {
        currentModal.addClass('visible');
        currentModal.find('.bookmark-list-modal').addClass('visible');
    }, 10);

    // 이벤트 핸들러
    currentModal.find('.bookmark-modal-close').on('click', function() {
        currentModal.removeClass('visible');
        currentModal.find('.bookmark-list-modal').removeClass('visible');
        
        setTimeout(() => {
            currentModal.remove();
            currentModal = null;
        }, 300);
    });
    
    // 모든 이벤트 핸들러 바인딩
    bindModalEventHandlers();
}

/**
 * 북마크 수정 모달
 */
async function editBookmarkModal(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    // 북마크 이름 수정
    const nameResult = await callGenericPopup(
        `책갈피 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        createBookmarkListModal(); // 목록으로 돌아가기
        return;
    }

    const newName = nameResult.trim();
    if (!newName) {
        toastr.error('책갈피 이름을 입력해주세요.');
        createBookmarkListModal();
        return;
    }

    // 설명 수정
    const descResult = await callGenericPopup(
        '책갈피 설명 수정 (선택사항)',
        POPUP_TYPE.INPUT,
        bookmark.description || ''
    );

    if (descResult === false || descResult === null) {
        // 설명 수정을 취소해도 이름은 이미 입력했으므로 기존 설명 유지
        editBookmark(bookmarkId, newName, bookmark.description);
        toastr.success('책갈피 이름이 수정되었습니다.');
    } else {
        editBookmark(bookmarkId, newName, descResult);
        toastr.success('책갈피가 수정되었습니다.');
    }

    // 목록 새로고침
    refreshBookmarkListInModal();
}

/**
 * 북마크 이름만 수정
 */
async function editBookmarkNameOnly(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    const nameResult = await callGenericPopup(
        `책갈피 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        return;
    }

    const newName = nameResult.trim();
    if (!newName) {
        toastr.error('책갈피 이름을 입력해주세요.');
        return;
    }

    // 이름만 수정 (설명은 그대로 유지)
    editBookmark(bookmarkId, newName, bookmark.description);
    toastr.success('책갈피 이름이 수정되었습니다.');

    // 목록 새로고침
    refreshBookmarkListInModal();
}

/**
 * 북마크 삭제 확인
 */
async function confirmDeleteBookmark(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    const result = await callGenericPopup(
        `"${bookmark.name}" 책갈피를 삭제하시겠습니까?`,
        POPUP_TYPE.CONFIRM
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        deleteBookmark(bookmarkId);
        
        // 북마크 상태 새로고침
        setTimeout(() => {
            refreshBookmarkIcons();
        }, 100);
        
        toastr.success('책갈피가 삭제되었습니다.');
        
        // 목록 모달 새로고침
        refreshBookmarkListInModal();
    }
}











/**
 * 메시지에 북마크 아이콘 추가
 */
function addBookmarkIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const buttonContainer = messageElement.find('.extraMesButtons');
        
        // extraMesButtons 컨테이너가 있고 이미 버튼이 없으면 추가
        if (buttonContainer.length && !buttonContainer.find('.bookmark-icon').length) {
            buttonContainer.prepend(messageButtonHtml);
        }
    });
    
    // 아이콘 추가 후 북마크 상태 새로고침
    refreshBookmarkIcons();
}

/**
 * 북마크 상태 새로고침 (북마크된 메시지만 em변수 색상 적용)
 */
function refreshBookmarkIcons() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const messageId = messageElement.attr('mesid');
        const bookmarkIcon = messageElement.find('.bookmark-icon i');
        
        if (messageId && bookmarkIcon.length) {
            const isBookmarked = bookmarks.some(bookmark => bookmark.messageId === parseInt(messageId));
            
            if (isBookmarked) {
                // 북마크된 메시지: fa-solid + quote변수 색상
                bookmarkIcon.removeClass('fa-regular').addClass('fa-solid');
                bookmarkIcon.css('color', 'var(--SmartThemeQuoteColor)');
            } else {
                // 북마크되지 않은 메시지: fa-regular + 기본 색상
                bookmarkIcon.removeClass('fa-solid').addClass('fa-regular');
                bookmarkIcon.css('color', '');
            }
        }
    });
}

/**
 * 새 메시지 핸들러
 */
function handleNewMessage() {
    setTimeout(() => {
        addBookmarkIconsToMessages();
    }, 150);
}

/**
 * 메시지 업데이트 핸들러
 */
function handleMessageUpdate() {
    setTimeout(() => {
        addBookmarkIconsToMessages();
    }, 150);
}

/**
 * 채팅 변경 처리 - 새로운 채팅의 북마크를 로드
 */
function handleChatChanged() {
    
    // 새로운 채팅의 북마크를 로드
    loadBookmarks();
    
    // 현재 채팅의 북마크 인덱스 동기화
    const context = getContext();
    if (context && context.characterId !== undefined && context.chatId !== undefined) {
        updateBookmarkIndex(context.characterId, context.chatId, bookmarks.length);
    }
    
    // UI 업데이트
    setTimeout(() => {
        addBookmarkIconsToMessages();
    }, 150);
}

/**
 * 요술봉 메뉴에 버튼 추가
 */
async function addToWandMenu() {
    try {
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        
        const extensionsMenu = $("#extensionsMenu");
        if (extensionsMenu.length > 0) {
            extensionsMenu.append(buttonHtml);
            $("#bookmark_manager_button").on("click", createBookmarkListModal);
        } else {
            setTimeout(addToWandMenu, 1000);
        }
    } catch (error) {
        console.error('요술봉 메뉴 버튼 추가 실패:', error);
    }
}

/**
 * 확장 초기화
 */
function initializeBookmarkManager() {
    
    // Extension Settings 초기화
    initializeBookmarkIndex();
    
    // 책갈피 데이터 로드
    loadBookmarks();
    
    // 현재 채팅의 북마크 인덱스 동기화 (로드 후)
    const context = getContext();
    if (context && context.characterId !== undefined && context.chatId !== undefined) {
        updateBookmarkIndex(context.characterId, context.chatId, bookmarks.length);
    }
    
    // 기존 메시지에 아이콘 추가
    addBookmarkIconsToMessages();
    
    // 이벤트 리스너 설정
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdate);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    
    // 추가 메시지 로딩 시 처리 (핵심 기능)
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
        setTimeout(() => {
            addBookmarkIconsToMessages();
        }, 150);
    });
    
    // DOM 변경 감시 (실시간 아이콘 추가)
    const chatElement = document.getElementById('chat');
    if (chatElement) {
        const chatObserver = new MutationObserver((mutations) => {
            if (mutations.some(m => m.addedNodes.length > 0)) {
                requestAnimationFrame(addBookmarkIconsToMessages);
            }
        });
        chatObserver.observe(chatElement, { childList: true });
    }
    
    // 책갈피 아이콘 클릭 이벤트
    $(document).on('click', '.bookmark-icon', function(event) {
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        if (messageId !== undefined) {
            // 이미 북마크된 메시지인지 확인
            const isBookmarked = bookmarks.some(bookmark => bookmark.messageId === parseInt(messageId));
            
            if (isBookmarked) {
                showBookmarkRemoveConfirm(messageId);
            } else {
                createBookmarkModal(messageId);
            }
        } else {
            console.error('[Bookmark] 메시지 ID를 찾을 수 없습니다');
        }
    });
    
    // 요술봉 메뉴에 버튼 추가
    setTimeout(addToWandMenu, 1000);
    
}

// jQuery 준비 완료 시 초기화
jQuery(() => {
    initializeBookmarkManager();
});