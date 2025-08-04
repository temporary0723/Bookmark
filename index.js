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

// 마이그레이션 완료 플래그 키
const MIGRATION_COMPLETED_KEY = 'bookmark_migration_completed';

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
        console.warn('[Bookmark] 인덱스 업데이트 실패: characterId 또는 chatId가 정의되지 않음');
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
    console.log(`[Bookmark] 인덱스 업데이트: 캐릭터 ${characterId}, 채팅 ${chatId}, 책갈피 수: ${bookmarkCount}`);
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
        
        // 인덱스 요약 정보 표시
        const summary = getBookmarkIndexSummary();
        
        // 두 번째 확인: 구체적인 삭제 대상 정보 제공
        const secondConfirm = await callGenericPopup(
            `삭제될 데이터:\n• ${summary.totalCharacters}개 캐릭터\n• ${summary.totalChats}개 채팅\n• ${summary.totalBookmarks}개 책갈피\n\n⚠️ 이 작업은 되돌릴 수 없습니다!\n데이터를 먼저 백업하는 것을 강력히 권장합니다.\n\n정말로 모든 책갈피를 삭제하시겠습니까?`,
            POPUP_TYPE.CONFIRM
        );
        
        if (secondConfirm !== POPUP_RESULT.AFFIRMATIVE) {
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
        
        // 인덱스에 있는 모든 캐릭터의 북마크 삭제
        for (const [characterIdStr, characterChats] of Object.entries(bookmarkIndex)) {
            const charIndex = parseInt(characterIdStr);
            const character = context.characters[charIndex];
            
            if (!character || !character.name || !character.avatar) {
                console.warn(`[Bookmark] 캐릭터 ID ${charIndex}를 찾을 수 없습니다.`);
                continue;
            }
            
            console.log(`[Bookmark] 캐릭터 "${character.name}" 책갈피 삭제 중...`);
            
            for (const [chatId] of Object.entries(characterChats)) {
                try {
                    // 현재 캐릭터의 현재 채팅인 경우
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
                        console.warn(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 가져오기 실패`);
                        totalErrors++;
                        continue;
                    }
                    
                    const chatData = await chatResponse.json();
                    
                    if (!Array.isArray(chatData) || chatData.length === 0) {
                        console.warn(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 데이터가 비어있음`);
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
        
        // 현재 채팅의 북마크 상태를 메타데이터에서 다시 로드하여 완전히 동기화
        loadBookmarks(); // 메타데이터가 삭제되었으므로 빈 배열이 로드됨
        
        // UI 새로고침
        refreshBookmarkIcons();
        
        if (totalErrors === 0) {
            toastr.success(`모든 책갈피 삭제 완료!\n• ${deletedCharacters}개 캐릭터\n• ${deletedChats}개 채팅에서 책갈피가 삭제되었습니다.`);
        } else {
            toastr.warning(`책갈피 삭제 완료 (일부 오류 발생)\n• ${deletedCharacters}개 캐릭터\n• ${deletedChats}개 채팅에서 삭제 성공\n• ${totalErrors}개 오류 발생`);
        }
        
        console.log(`[Bookmark] 전체 삭제 완료 - 캐릭터: ${deletedCharacters}, 채팅: ${deletedChats}, 오류: ${totalErrors}`);
        
        // 모달 새로고침 (메타데이터 로드 완료 후 업데이트)
        setTimeout(() => {
            refreshBookmarkListInModal();
        }, 100);
        
    } catch (error) {
        console.error('[Bookmark] 전체 삭제 중 오류:', error);
        toastr.error('전체 삭제 중 오류가 발생했습니다.');
    }
}

/**
 * 기존 localStorage의 북마크를 현재 채팅으로 마이그레이션
 */
function migrateOldBookmarks() {
    try {
        // 마이그레이션이 이미 완료되었는지 확인
        const migrationCompleted = localStorage.getItem(MIGRATION_COMPLETED_KEY);
        if (migrationCompleted === 'true') {
            return; // 이미 마이그레이션 완료됨
        }

        // 기존 localStorage에서 북마크 가져오기
        const oldBookmarks = localStorage.getItem('st_bookmarks');
        if (!oldBookmarks) {
            // 기존 북마크가 없으므로 마이그레이션 완료로 표시
            localStorage.setItem(MIGRATION_COMPLETED_KEY, 'true');
            return;
        }

        const parsedOldBookmarks = JSON.parse(oldBookmarks);
        if (!Array.isArray(parsedOldBookmarks) || parsedOldBookmarks.length === 0) {
            localStorage.setItem(MIGRATION_COMPLETED_KEY, 'true');
            return;
        }

        console.log(`[Bookmark] 기존 책갈피 ${parsedOldBookmarks.length}개를 현재 채팅으로 마이그레이션합니다.`);

        const context = getContext();
        if (context && context.chatMetadata) {
            // 현재 채팅에 기존 북마크가 없는 경우에만 마이그레이션
            const existingBookmarks = context.chatMetadata[BOOKMARK_METADATA_KEY];
            if (!existingBookmarks || !Array.isArray(existingBookmarks) || existingBookmarks.length === 0) {
                context.chatMetadata[BOOKMARK_METADATA_KEY] = [...parsedOldBookmarks];
                saveMetadataDebounced();
                console.log('[Bookmark] 기존 책갈피를 현재 채팅으로 마이그레이션 완료');
            }
        }

        // 마이그레이션 완료 플래그 설정
        localStorage.setItem(MIGRATION_COMPLETED_KEY, 'true');
        
        // 기존 localStorage 북마크는 유지 (다른 채팅에서도 볼 수 있도록)
        // localStorage.removeItem('st_bookmarks'); // 이 줄은 주석 처리해서 백업으로 유지
        
    } catch (error) {
        console.error('[Bookmark] 마이그레이션 중 오류 발생:', error);
    }
}

/**
 * 현재 채팅의 메타데이터에서 북마크 로드
 */
function loadBookmarks() {
    try {
        const context = getContext();
        if (!context || !context.chatMetadata) {
            console.log('[Bookmark] 컨텍스트 또는 메타데이터를 찾을 수 없음. 빈 배열로 초기화.');
            console.log(`[Bookmark] context 존재: ${!!context}, chatMetadata 존재: ${!!(context && context.chatMetadata)}`);
            bookmarks = [];
            return;
        }

        console.log(`[Bookmark] 현재 채팅 정보 - characterId: ${context.characterId}, chatId: ${context.chatId}`);
        console.log(`[Bookmark] 메타데이터 키들: ${Object.keys(context.chatMetadata).join(', ')}`);

        // 기존 북마크 마이그레이션 시도 (한 번만 실행됨)
        migrateOldBookmarks();

        const savedBookmarks = context.chatMetadata[BOOKMARK_METADATA_KEY];
        console.log(`[Bookmark] ${BOOKMARK_METADATA_KEY} 키에서 찾은 데이터:`, savedBookmarks ? `배열 (${savedBookmarks.length}개)` : savedBookmarks);
        
        if (savedBookmarks && Array.isArray(savedBookmarks)) {
            bookmarks = savedBookmarks;
            console.log(`[Bookmark] 현재 채팅에서 ${bookmarks.length}개의 책갈피를 로드했습니다. (캐릭터: ${context.characterId}, 채팅: ${context.chatId})`);
            if (bookmarks.length > 0) {
                console.log(`[Bookmark] 첫 번째 책갈피 예시:`, {
                    id: bookmarks[0].id,
                    messageId: bookmarks[0].messageId,
                    name: bookmarks[0].name
                });
            }
        } else {
            bookmarks = [];
            console.log(`[Bookmark] 현재 채팅에 저장된 책갈피가 없습니다. 빈 배열로 초기화. (캐릭터: ${context.characterId}, 채팅: ${context.chatId})`);
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
        
        console.log(`[Bookmark] 현재 채팅에 ${bookmarks.length}개의 책갈피를 저장했습니다.`);
    } catch (error) {
        console.error('책갈피 저장 실패:', error);
    }
}

/**
 * 메시지 ID로 이동 (SillyTavern 공식 명령어 사용)
 */
async function jumpToMessage(messageId) {
    try {
        console.log(`[Bookmark] 메시지 ID ${messageId}로 이동 시작`);
        
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
                console.log(`[Bookmark] 메시지 ID ${messageId}로 이동 완료`);
                
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
            console.log(`[Bookmark] 메시지 ID ${messageId} 강조 효과 적용`);
        }
    } catch (error) {
        console.warn('[Bookmark] 메시지 강조 효과 실패:', error);
    }
}

/**
 * 북마크 해제 확인 모달
 */
async function showBookmarkRemoveConfirm(messageId) {
    console.log(`[Bookmark] showBookmarkRemoveConfirm 함수 시작 - messageId: ${messageId}`);
    
    const bookmark = bookmarks.find(b => b.messageId === parseInt(messageId));
    const bookmarkName = bookmark ? bookmark.name : `메시지 #${messageId}`;
    
    const result = await callGenericPopup(
        `책갈피 "${bookmarkName}"를 삭제하시겠습니까?`,
        POPUP_TYPE.CONFIRM
    );
    
    console.log(`[Bookmark] 해제 확인 모달 결과: ${result}`);
    
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        // 북마크 삭제
        const bookmarkIndex = bookmarks.findIndex(b => b.messageId === parseInt(messageId));
        if (bookmarkIndex !== -1) {
            const deletedBookmark = bookmarks.splice(bookmarkIndex, 1)[0];
            saveBookmarks();
            refreshBookmarkIcons();
            refreshBookmarkListInModal(); // 모달이 열려있으면 새로고침
            toastr.success(`책갈피 "${deletedBookmark.name}"가 삭제되었습니다.`);
            console.log(`[Bookmark] 책갈피 삭제 완료: ${deletedBookmark.name}`);
        }
    }
}

/**
 * 북마크 추가 모달 생성
 */
async function createBookmarkModal(messageId) {
    console.log(`[Bookmark] createBookmarkModal 함수 시작 - messageId: ${messageId}`);
    
    const result = await callGenericPopup(
        '책갈피 제목을 입력하세요',
        POPUP_TYPE.INPUT,
        ''
    );
    
    console.log(`[Bookmark] 모달 결과: ${result}`);
    
    if (result && result.trim()) {
        const bookmarkName = result.trim();
        console.log(`[Bookmark] 책갈피 추가 - 이름: "${bookmarkName}"`);
        
        // 북마크 추가 (설명은 빈 문자열로)
        addBookmark(messageId, bookmarkName, '');
        
        // 북마크 상태 새로고침
        setTimeout(() => {
            refreshBookmarkIcons();
            refreshBookmarkListInModal(); // 모달이 열려있으면 새로고침
        }, 100);
        
        toastr.success('책갈피가 추가되었습니다.');
    } else {
        console.log('[Bookmark] 책갈피 추가 취소됨');
    }
}

/**
 * 북마크 모달 닫기 (더 이상 사용하지 않음)
 */
function closeBookmarkModal() {
    // SillyTavern 기본 모달 사용으로 인해 더 이상 필요 없음
    console.log('[Bookmark] closeBookmarkModal 호출됨 (deprecated)');
}

/**
 * 북마크 추가
 */
function addBookmark(messageId, name, description) {
    console.log(`[Bookmark] addBookmark 함수 시작 - messageId: ${messageId}, name: "${name}"`);
    
    const bookmark = {
        id: uuidv4(),
        messageId: parseInt(messageId),
        name: name,
        description: description,
        createdAt: new Date().toISOString()
    };

    console.log('[Bookmark] 책갈피 객체 생성:', bookmark);
    
    bookmarks.push(bookmark);
    bookmarks.sort((a, b) => a.messageId - b.messageId);
    
    console.log(`[Bookmark] 책갈피 배열에 추가 완료. 총 ${bookmarks.length}개`);
    
    saveBookmarks();
    console.log('[Bookmark] 책갈피 저장 완료');
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
        console.log('[Bookmark] 모달이 열려있지 않아 리스트 새로고침을 건너뜀');
        return; // 모달이 열려있지 않으면 아무것도 하지 않음
    }
    
    console.log(`[Bookmark] 모달 내 책갈피 리스트 새로고침 - 현재 북마크 수: ${bookmarks.length}`);
    
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
            ${dataControls[0].outerHTML}
            <div class="no-bookmarks">저장된 책갈피가 없습니다.</div>
        `);
    } else {
        modalBody.html(`
            ${dataControls[0].outerHTML}
            <div class="bookmark-list">${bookmarkList}</div>
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
            console.log(`[Bookmark] 설명 자동 저장 - ID: ${bookmarkId}`);
        }
    });

    // 설명 필드 클릭 시 이동 방지
    currentModal.find('.bookmark-description-field').off('click').on('click', function(e) {
        e.stopPropagation();
    });

    // 데이터 불러오기 버튼 이벤트
    currentModal.find('.bookmark-import-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        importBookmarkData();
    });

    // 데이터 내보내기 버튼 이벤트
    currentModal.find('.bookmark-export-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        exportBookmarkData();
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
                    <div class="bookmark-data-controls">
                        <button class="bookmark-import-btn" title="책갈피 데이터 불러오기">
                            <i class="fa-solid fa-file-import"></i>
                            <span>데이터 불러오기</span>
                        </button>
                        <button class="bookmark-export-btn" title="책갈피 데이터 내보내기">
                            <i class="fa-solid fa-file-export"></i>
                            <span>데이터 내보내기</span>
                        </button>
                        <button class="bookmark-delete-all-btn" title="모든 캐릭터의 책갈피 완전 삭제" style="background-color: #dc3545; border-color: #dc3545; color: white; margin-left: 10px;">
                            <i class="fa-solid fa-trash-can"></i>
                            <span>전체 삭제</span>
                        </button>
                    </div>
                    ${bookmarks.length === 0 
                        ? '<div class="no-bookmarks">저장된 책갈피가 없습니다.</div>' 
                        : `<div class="bookmark-list">${bookmarkList}</div>`
                    }
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

    console.log(`[Bookmark] 책갈피 수정 모달 - ID: ${bookmarkId}`);

    // 북마크 이름 수정
    const nameResult = await callGenericPopup(
        `책갈피 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        console.log('[Bookmark] 책갈피 이름 수정 취소됨');
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
        console.log('[Bookmark] 설명 수정 취소, 기존 설명 유지');
        editBookmark(bookmarkId, newName, bookmark.description);
        toastr.success('책갈피 이름이 수정되었습니다.');
    } else {
        console.log(`[Bookmark] 책갈피 수정 완료 - 이름: "${newName}", 설명: "${descResult}"`);
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

    console.log(`[Bookmark] 책갈피 이름 수정 - ID: ${bookmarkId}`);

    const nameResult = await callGenericPopup(
        `책갈피 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        console.log('[Bookmark] 책갈피 이름 수정 취소됨');
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
 * 모든 캐릭터의 모든 채팅에서 북마크 데이터 수집 (인덱스 기반 최적화)
 */
async function collectAllBookmarksFromAllCharacters() {
    const context = getContext();
    const allCharacterBookmarks = [];
    
    try {
        if (!context || !context.characters || !Array.isArray(context.characters)) {
            console.warn('[Bookmark] 캐릭터 목록을 찾을 수 없어 현재 채팅 책갈피만 수집합니다.');
            return [{
                characterName: '현재 캐릭터',
                characterId: context.characterId || 'unknown',
                chats: [{ 
                    chatName: '현재 채팅', 
                    fileName: 'current', 
                    bookmarks: [...bookmarks] 
                }]
            }];
        }

        // 인덱스를 사용하여 북마크가 있는 캐릭터들만 찾기
        const bookmarkIndex = getBookmarkIndex();
        const charactersWithBookmarks = Object.keys(bookmarkIndex);
        
        if (charactersWithBookmarks.length === 0) {
            console.log('[Bookmark] 인덱스에서 책갈피가 있는 캐릭터를 찾지 못했습니다.');
            return [];
        }

        console.log(`[Bookmark] 인덱스 기반 수집: ${charactersWithBookmarks.length}개 캐릭터에서 책갈피를 수집합니다...`);
        let totalProcessedChats = 0;
        let totalBookmarks = 0;

        for (const characterIdStr of charactersWithBookmarks) {
            const charIndex = parseInt(characterIdStr);
            const character = context.characters[charIndex];
            
            if (!character || !character.name || !character.avatar) {
                console.warn(`[Bookmark] 캐릭터 ID ${charIndex}에 해당하는 캐릭터를 찾을 수 없습니다.`);
                continue;
            }

            try {
                console.log(`[Bookmark] 캐릭터 "${character.name}" 처리 중... (인덱스 ID: ${charIndex})`);

                const characterChatBookmarks = [];
                const characterChats = bookmarkIndex[characterIdStr];

                // 인덱스에 있는 채팅들만 처리
                for (const [chatId, indexInfo] of Object.entries(characterChats)) {
                    try {
                        // 현재 캐릭터의 현재 채팅인 경우 메모리의 북마크 사용
                        if (charIndex === context.characterId && chatId === context.chatId) {
                            if (bookmarks.length > 0) {
                                characterChatBookmarks.push({
                                    chatName: '현재 채팅',
                                    fileName: chatId,
                                    bookmarks: [...bookmarks],
                                    isCurrent: true
                                });
                                totalBookmarks += bookmarks.length;
                            }
                            totalProcessedChats++;
                            continue;
                        }

                        // 다른 채팅의 메타데이터 가져오기
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
                            console.warn(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 데이터 가져오기 실패: ${chatResponse.status}`);
                            continue;
                        }

                        const chatData = await chatResponse.json();
                        let chatMetadata = null;

                        // 메타데이터 추출
                        if (Array.isArray(chatData) && chatData.length > 0) {
                            const firstItem = chatData[0];
                            if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
                                chatMetadata = firstItem.chat_metadata || firstItem;
                            }
                        }

                        // 북마크 추출
                        const chatBookmarks = chatMetadata && chatMetadata[BOOKMARK_METADATA_KEY] 
                            ? chatMetadata[BOOKMARK_METADATA_KEY] 
                            : [];

                        if (Array.isArray(chatBookmarks) && chatBookmarks.length > 0) {
                            // 채팅 이름 추출 시도
                            let chatName = chatId;
                            try {
                                // 캐릭터의 채팅 목록에서 이름 찾기
                                const chatListResponse = await fetch('/api/characters/chats', {
                                    method: 'POST',
                                    headers: getRequestHeaders(),
                                    body: JSON.stringify({ avatar_url: character.avatar })
                                });
                                
                                if (chatListResponse.ok) {
                                    const chatList = await chatListResponse.json();
                                    const chatInfo = chatList.find(c => 
                                        (c.file_name || c.fileName) === chatId || 
                                        (c.file_name || c.fileName) === chatId + '.jsonl'
                                    );
                                    if (chatInfo) {
                                        chatName = chatInfo.chat_name || chatInfo.name || chatId;
                                    }
                                }
                            } catch (nameError) {
                                console.warn(`[Bookmark] 채팅 이름 가져오기 실패: ${nameError.message}`);
                            }

                            characterChatBookmarks.push({
                                chatName: chatName,
                                fileName: chatId,
                                bookmarks: chatBookmarks
                            });
                            totalBookmarks += chatBookmarks.length;
                            console.log(`[Bookmark] 캐릭터 "${character.name}" 채팅 "${chatName}": ${chatBookmarks.length}개 책갈피 수집`);
                        }

                        totalProcessedChats++;

                    } catch (error) {
                        console.error(`[Bookmark] 캐릭터 "${character.name}" 채팅 ${chatId} 처리 중 오류:`, error);
                    }
                }

                // 북마크가 있는 캐릭터만 결과에 포함
                if (characterChatBookmarks.length > 0) {
                    allCharacterBookmarks.push({
                        characterName: character.name,
                        characterId: charIndex,
                        avatar: character.avatar,
                        chats: characterChatBookmarks
                    });
                }

            } catch (error) {
                console.error(`[Bookmark] 캐릭터 "${character.name}" 처리 중 오류:`, error);
            }
        }

        console.log(`[Bookmark] 인덱스 기반 수집 완료: ${allCharacterBookmarks.length}개 캐릭터, ${totalProcessedChats}개 채팅, 총 ${totalBookmarks}개 책갈피`);
        return allCharacterBookmarks;

    } catch (error) {
        console.error('[Bookmark] 모든 캐릭터 책갈피 수집 중 오류:', error);
        // 오류 발생 시 현재 채팅 북마크만 반환
        return [{
            characterName: '현재 캐릭터',
            characterId: context.characterId || 'unknown',
            chats: [{ 
                chatName: '현재 채팅', 
                fileName: 'current', 
                bookmarks: [...bookmarks] 
            }]
        }];
    }
}





/**
 * 모든 캐릭터의 모든 채팅 북마크 내보내기 (인덱스 기반 최적화)
 */
async function exportAllCharactersBookmarks() {
    try {
        // 인덱스 요약으로 빠른 미리보기
        const indexSummary = getBookmarkIndexSummary();
        
        if (indexSummary.totalCharacters === 0) {
            toastr.warning('내보낼 책갈피가 없습니다.');
            return;
        }
        
        toastr.info(`인덱스 기반 수집: ${indexSummary.totalCharacters}개 캐릭터의 책갈피를 수집하고 있습니다... (기존 방식보다 훨씬 빠릅니다!)`);
        
        const allCharacterBookmarks = await collectAllBookmarksFromAllCharacters();
        
        // 전체 통계 계산
        let totalChats = 0;
        let totalBookmarks = 0;
        
        allCharacterBookmarks.forEach(charData => {
            totalChats += charData.chats.length;
            charData.chats.forEach(chat => {
                totalBookmarks += chat.bookmarks.length;
            });
        });
        
        const exportData = {
            version: '3.0',
            exportDate: new Date().toISOString(),
            scope: 'all_characters',
            totalCharacters: allCharacterBookmarks.length,
            totalChats: totalChats,
            totalBookmarks: totalBookmarks,
            characterBookmarks: allCharacterBookmarks,
            exportMethod: 'index_optimized' // 최적화 방식 표시
        };
        
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `bookmarks_all_characters_${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        
        toastr.success(`모든 캐릭터의 책갈피가 내보내기되었습니다. (${allCharacterBookmarks.length}개 캐릭터, ${totalChats}개 채팅, 총 ${totalBookmarks}개 책갈피) ⚡ 인덱스 최적화 적용`);
        console.log('[Bookmark] 모든 캐릭터 책갈피 내보내기 완료 (인덱스 기반)');
    } catch (error) {
        console.error('[Bookmark] 데이터 내보내기 실패:', error);
        toastr.error('데이터 내보내기 중 오류가 발생했습니다.');
    }
}

/**
 * 책갈피 데이터 내보내기
 */
async function exportBookmarkData() {
    try {
        // 확인 팝업
        const result = await callGenericPopup(
            '모든 캐릭터의 책갈피를 내보내시겠습니까?',
            POPUP_TYPE.CONFIRM
        );
        
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            await exportAllCharactersBookmarks();
        }
        
    } catch (error) {
        console.error('[Bookmark] 내보내기 중 오류:', error);
        toastr.error('내보내기 중 오류가 발생했습니다.');
    }
}

/**
 * v1.0 형식 북마크를 현재 채팅에 불러오기
 */
function importLegacyBookmarks(legacyBookmarks) {
                    let importedCount = 0;
                    let duplicatedCount = 0;
                    
    legacyBookmarks.forEach(importBookmark => {
                        // 중복 검사 (messageId와 name이 모두 같은 경우)
                        const exists = bookmarks.some(existing => 
                            existing.messageId === importBookmark.messageId && 
                            existing.name === importBookmark.name
                        );
                        
                        if (!exists) {
                            // 새 ID 생성
                            const newBookmark = {
                                ...importBookmark,
                id: uuidv4()
                            };
                            bookmarks.push(newBookmark);
                            importedCount++;
                        } else {
                            duplicatedCount++;
                        }
                    });
                    
                    // 정렬 및 저장
                    bookmarks.sort((a, b) => a.messageId - b.messageId);
                    saveBookmarks();
                    refreshBookmarkIcons();
                    
    return { importedCount, duplicatedCount };
}



/**
 * v3.0 형식 북마크를 각 캐릭터별/채팅별로 원래 위치에 불러오기
 */
async function importV3ToOriginalLocations(characterBookmarks) {
    const context = getContext();
    if (!context || !context.characters || !Array.isArray(context.characters)) {
        throw new Error('캐릭터 목록을 찾을 수 없습니다.');
    }
    
    console.log(`[Bookmark] v3.0 불러오기 시작 - 복원할 캐릭터 수: ${characterBookmarks.length}`);
    console.log(`[Bookmark] 현재 SillyTavern에 로드된 캐릭터 수: ${context.characters.length}`);
    
    let processedCharacters = 0;
    let processedChats = 0;
    let totalImported = 0;
    let notFoundCharacters = [];
    
    for (const charData of characterBookmarks) {
        try {
            console.log(`[Bookmark] 캐릭터 "${charData.characterName}" 처리 시작 - 채팅 수: ${charData.chats.length}`);
            
            // 캐릭터 찾기 (이름으로 매칭)
            const targetCharacter = context.characters.find(char => 
                char && char.name === charData.characterName
            );
            
            if (!targetCharacter) {
                console.warn(`[Bookmark] 캐릭터 "${charData.characterName}"을 찾을 수 없습니다.`);
                console.log(`[Bookmark] 현재 로드된 캐릭터 이름들: ${context.characters.map(c => c?.name || 'unnamed').join(', ')}`);
                notFoundCharacters.push(charData.characterName);
                continue;
            }
            
            console.log(`[Bookmark] 캐릭터 "${charData.characterName}" 발견 - avatar: ${targetCharacter.avatar}`);
            
            for (const chatData of charData.chats) {
                try {
                    console.log(`[Bookmark] 채팅 "${chatData.chatName}" (${chatData.fileName}) 처리 시작 - 책갈피 수: ${chatData.bookmarks.length}`);
                    
                    // 현재 캐릭터의 현재 채팅인 경우
                    const targetCharIndex = context.characters.indexOf(targetCharacter);
                    if (targetCharIndex === context.characterId && chatData.fileName === context.chatId) {
                        console.log(`[Bookmark] 현재 채팅으로 감지됨 - 메모리에 직접 추가`);
                        chatData.bookmarks.forEach(importBookmark => {
                            const exists = bookmarks.some(existing => 
                                existing.messageId === importBookmark.messageId && 
                                existing.name === importBookmark.name
                            );
                            
                            if (!exists) {
                                bookmarks.push({
                                    ...importBookmark,
                                    id: uuidv4()
                                });
                                totalImported++;
                            }
                        });
                        
                        bookmarks.sort((a, b) => a.messageId - b.messageId);
                        saveBookmarks();
                        processedChats++;
                        console.log(`[Bookmark] 현재 채팅에 ${chatData.bookmarks.length}개 책갈피 추가 완료`);
                        continue;
                    }
                    
                    // 다른 채팅의 메타데이터 가져오기
                    const chatRequestBody = {
                        ch_name: targetCharacter.name,
                        file_name: chatData.fileName.replace('.jsonl', ''),
                        avatar_url: targetCharacter.avatar
                    };
                    
                    console.log(`[Bookmark] 채팅 데이터 요청:`, chatRequestBody);
                    
                    const chatResponse = await fetch('/api/chats/get', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify(chatRequestBody)
                    });
                    
                    if (!chatResponse.ok) {
                        console.warn(`[Bookmark] 캐릭터 "${charData.characterName}" 채팅 ${chatData.fileName} 데이터 가져오기 실패: ${chatResponse.status} - ${chatResponse.statusText}`);
                        continue;
                    }
                    
                    const chatDataResponse = await chatResponse.json();
                    console.log(`[Bookmark] 채팅 데이터 응답 타입: ${Array.isArray(chatDataResponse) ? 'Array' : typeof chatDataResponse}, 길이/키: ${Array.isArray(chatDataResponse) ? chatDataResponse.length : Object.keys(chatDataResponse).length}`);
                    
                    let chatMetadata = null;
                    
                    // 메타데이터 추출
                    if (Array.isArray(chatDataResponse) && chatDataResponse.length > 0) {
                        const firstItem = chatDataResponse[0];
                        if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
                            chatMetadata = firstItem.chat_metadata || firstItem;
                            console.log(`[Bookmark] 메타데이터 추출 성공 - 키들: ${Object.keys(chatMetadata).join(', ')}`);
                        } else {
                            console.log(`[Bookmark] 첫 번째 아이템이 메타데이터가 아님: ${typeof firstItem}`);
                        }
                    } else {
                        console.log(`[Bookmark] 채팅 응답이 비어있거나 배열이 아님`);
                    }
                    
                    if (!chatMetadata) {
                        console.log(`[Bookmark] 메타데이터 초기화`);
                        chatMetadata = {};
                    }
                    
                    // 기존 책갈피와 병합
                    const existingBookmarks = chatMetadata[BOOKMARK_METADATA_KEY] || [];
                    console.log(`[Bookmark] 기존 책갈피 수: ${existingBookmarks.length}, 추가할 책갈피 수: ${chatData.bookmarks.length}`);
                    
                    const mergedBookmarks = [...existingBookmarks];
                    let importedForThisChat = 0;
                    
                    chatData.bookmarks.forEach(importBookmark => {
                        const exists = mergedBookmarks.some(existing => 
                            existing.messageId === importBookmark.messageId && 
                            existing.name === importBookmark.name
                        );
                        
                        if (!exists) {
                            mergedBookmarks.push({
                                ...importBookmark,
                                id: uuidv4()
                            });
                            totalImported++;
                            importedForThisChat++;
                        }
                    });
                    
                    console.log(`[Bookmark] 이 채팅에 ${importedForThisChat}개 책갈피 추가됨 (총 ${mergedBookmarks.length}개)`);
                    
                    // 채팅 메타데이터 업데이트
                    chatMetadata[BOOKMARK_METADATA_KEY] = mergedBookmarks.sort((a, b) => a.messageId - b.messageId);
                    
                    // 전체 채팅 데이터 구성 (SillyTavern API 요구사항)
                    let chatContentToSave = [];
                    
                    // 메타데이터 객체 생성 (첫 번째 요소)
                    const metadataForSave = {
                        ...chatDataResponse[0], // 기존 메타데이터 속성 유지
                        chat_metadata: chatMetadata // 업데이트된 메타데이터로 교체
                    };
                    
                    chatContentToSave.push(metadataForSave);
                    
                    // 기존 메시지들 추가 (메타데이터 이후의 모든 요소들)
                    if (Array.isArray(chatDataResponse) && chatDataResponse.length > 1) {
                        chatContentToSave.push(...chatDataResponse.slice(1));
                    }
                    
                    // 서버에 저장
                    const saveRequestBody = {
                        ch_name: targetCharacter.name,
                        file_name: chatData.fileName.replace('.jsonl', ''),
                        avatar_url: targetCharacter.avatar,
                        chat: chatContentToSave,
                        force: true
                    };
                    
                    console.log(`[Bookmark] 전체 채팅 데이터 저장 요청:`, {
                        ch_name: saveRequestBody.ch_name,
                        file_name: saveRequestBody.file_name,
                        avatar_url: saveRequestBody.avatar_url,
                        chat_length: saveRequestBody.chat.length,
                        metadata_keys: Object.keys(saveRequestBody.chat[0].chat_metadata || {}),
                        bookmark_count: saveRequestBody.chat[0].chat_metadata?.[BOOKMARK_METADATA_KEY]?.length || 0
                    });
                    
                    const saveResponse = await fetch('/api/chats/save', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify(saveRequestBody)
                    });
                    
                    if (!saveResponse.ok) {
                        console.error(`[Bookmark] 채팅 데이터 저장 실패: ${saveResponse.status} - ${saveResponse.statusText}`);
                        const errorText = await saveResponse.text();
                        console.error(`[Bookmark] 저장 오류 응답:`, errorText);
                    } else {
                        const saveResult = await saveResponse.text();
                        console.log(`[Bookmark] 채팅 데이터 저장 응답:`, saveResult);
                        
                        // 저장 후 검증을 위해 다시 불러와서 확인
                        console.log(`[Bookmark] 저장 검증을 위해 채팅 데이터 다시 확인...`);
                        const verifyResponse = await fetch('/api/chats/get', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({
                                ch_name: targetCharacter.name,
                                file_name: chatData.fileName.replace('.jsonl', ''),
                                avatar_url: targetCharacter.avatar
                            })
                        });
                        
                        if (verifyResponse.ok) {
                            const verifyData = await verifyResponse.json();
                            if (Array.isArray(verifyData) && verifyData.length > 0) {
                                const verifyMetadata = verifyData[0].chat_metadata || verifyData[0];
                                const verifyBookmarks = verifyMetadata[BOOKMARK_METADATA_KEY] || [];
                                console.log(`[Bookmark] 저장 검증 결과: ${verifyBookmarks.length}개 책갈피 확인됨`);
                                if (verifyBookmarks.length !== mergedBookmarks.length) {
                                    console.error(`[Bookmark] 저장 검증 실패! 예상: ${mergedBookmarks.length}개, 실제: ${verifyBookmarks.length}개`);
                                } else {
                                    console.log(`[Bookmark] 저장 검증 성공! ✅`);
                                }
                            }
                        }
                    }
                    
                    processedChats++;
                    
                } catch (error) {
                    console.error(`[Bookmark] 캐릭터 "${charData.characterName}" 채팅 ${chatData.fileName} 처리 중 오류:`, error);
                }
            }
            
            processedCharacters++;
            console.log(`[Bookmark] 캐릭터 "${charData.characterName}" 처리 완료 - 처리된 채팅: ${charData.chats.length}개`);
            
        } catch (error) {
            console.error(`[Bookmark] 캐릭터 "${charData.characterName}" 처리 중 오류:`, error);
        }
    }
    
    console.log(`[Bookmark] v3.0 불러오기 완료 요약:`);
    console.log(`  - 처리된 캐릭터: ${processedCharacters}개`);
    console.log(`  - 처리된 채팅: ${processedChats}개`);
    console.log(`  - 총 추가된 책갈피: ${totalImported}개`);
    console.log(`  - 찾을 수 없는 캐릭터: ${notFoundCharacters.length}개 (${notFoundCharacters.join(', ')})`);
    
    return { 
        processedCharacters, 
        processedChats, 
        totalImported, 
        notFoundCharacters 
    };
}

/**
 * v2.0 형식 북마크를 각 채팅별로 원래 위치에 불러오기
 */
async function importV2ToOriginalChats(chatBookmarks) {
    const context = getContext();
    if (!context || !context.characters || context.characterId === undefined) {
        throw new Error('캐릭터 정보를 찾을 수 없습니다.');
    }
    
    const currentCharacter = context.characters[context.characterId];
    let processedChats = 0;
    let totalImported = 0;
    
    for (const chatData of chatBookmarks) {
        try {
            if (chatData.isCurrent || chatData.fileName === context.chatId) {
                // 현재 채팅인 경우 메모리에 직접 추가
                chatData.bookmarks.forEach(importBookmark => {
                    const exists = bookmarks.some(existing => 
                        existing.messageId === importBookmark.messageId && 
                        existing.name === importBookmark.name
                    );
                    
                    if (!exists) {
                        bookmarks.push({
                            ...importBookmark,
                            id: uuidv4()
                        });
                        totalImported++;
                    }
                });
                
                bookmarks.sort((a, b) => a.messageId - b.messageId);
                saveBookmarks();
                processedChats++;
                continue;
            }
            
            // 다른 채팅의 메타데이터 가져오기
            const chatRequestBody = {
                ch_name: currentCharacter.name,
                file_name: chatData.fileName.replace('.jsonl', ''),
                avatar_url: currentCharacter.avatar
            };
            
            const chatResponse = await fetch('/api/chats/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(chatRequestBody)
            });
            
            if (!chatResponse.ok) {
                console.warn(`[Bookmark] 채팅 ${chatData.fileName} 데이터 가져오기 실패`);
                continue;
            }
            
            const chatDataResponse = await chatResponse.json();
            let chatMetadata = null;
            
            // 메타데이터 추출
            if (Array.isArray(chatDataResponse) && chatDataResponse.length > 0) {
                const firstItem = chatDataResponse[0];
                if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
                    chatMetadata = firstItem.chat_metadata || firstItem;
                }
            }
            
            if (!chatMetadata) {
                chatMetadata = {};
            }
            
            // 기존 북마크와 병합
            const existingBookmarks = chatMetadata[BOOKMARK_METADATA_KEY] || [];
            const mergedBookmarks = [...existingBookmarks];
            
            chatData.bookmarks.forEach(importBookmark => {
                const exists = mergedBookmarks.some(existing => 
                    existing.messageId === importBookmark.messageId && 
                    existing.name === importBookmark.name
                );
                
                if (!exists) {
                    mergedBookmarks.push({
                        ...importBookmark,
                        id: uuidv4()
                    });
                    totalImported++;
                }
            });
            
            // 채팅 메타데이터 업데이트
            chatMetadata[BOOKMARK_METADATA_KEY] = mergedBookmarks.sort((a, b) => a.messageId - b.messageId);
            
            // 전체 채팅 데이터 구성 (SillyTavern API 요구사항)
            let chatContentToSave = [];
            
            // 메타데이터 객체 생성 (첫 번째 요소)
            const metadataForSave = {
                ...chatDataResponse[0], // 기존 메타데이터 속성 유지
                chat_metadata: chatMetadata // 업데이트된 메타데이터로 교체
            };
            
            chatContentToSave.push(metadataForSave);
            
            // 기존 메시지들 추가 (메타데이터 이후의 모든 요소들)
            if (Array.isArray(chatDataResponse) && chatDataResponse.length > 1) {
                chatContentToSave.push(...chatDataResponse.slice(1));
            }
            
            // 서버에 저장
            const saveRequestBody = {
                ch_name: currentCharacter.name,
                file_name: chatData.fileName.replace('.jsonl', ''),
                avatar_url: currentCharacter.avatar,
                chat: chatContentToSave,
                force: true
            };
            
            await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(saveRequestBody)
            });
            
            processedChats++;
            
        } catch (error) {
            console.error(`[Bookmark] 채팅 ${chatData.fileName} 처리 중 오류:`, error);
        }
    }
    
    return { processedChats, totalImported };
}

/**
 * 책갈피 데이터 불러오기
 */
function importBookmarkData() {
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = function(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    const importData = JSON.parse(e.target.result);
                    
                    // v1.0 형식 (기존 형식) 지원
                    if (importData.bookmarks && Array.isArray(importData.bookmarks) && importData.version !== '2.0') {
                        console.log('[Bookmark] v1.0 형식 파일을 감지했습니다.');
                        const result = importLegacyBookmarks(importData.bookmarks);
                        
                        if (result.importedCount > 0) {
                            toastr.success(`${result.importedCount}개의 책갈피를 불러왔습니다.${result.duplicatedCount > 0 ? ` (중복 ${result.duplicatedCount}개 제외)` : ''}`);
                            // v1.0은 현재 채팅에 직접 추가하므로 아이콘과 모달만 새로고침
                            refreshBookmarkIcons();
                            // DOM 업데이트 완료 후 모달 새로고침
                            setTimeout(() => {
                                refreshBookmarkListInModal();
                            }, 100);
                        } else {
                            toastr.info('새로운 책갈피가 없습니다. (모두 중복)');
                        }
                    
                        console.log(`[Bookmark] v1.0 데이터 불러오기 완료 - 추가: ${result.importedCount}, 중복: ${result.duplicatedCount}`);
                        return;
                    }
                    
                    // v2.0 형식 (새로운 형식) 지원
                    if (importData.version === '2.0' && importData.chatBookmarks && Array.isArray(importData.chatBookmarks)) {
                        console.log('[Bookmark] v2.0 형식 파일을 감지했습니다.');
                        
                        const totalBookmarks = importData.chatBookmarks.reduce((sum, chat) => sum + chat.bookmarks.length, 0);
                        
                        // 각 채팅별로 원래 위치에 불러오기
                        toastr.info(`총 ${importData.totalChats}개 채팅의 ${totalBookmarks}개 책갈피를 복원하고 있습니다... 시간이 걸릴 수 있습니다.`);
                        const result = await importV2ToOriginalChats(importData.chatBookmarks);
                        toastr.success(`${result.processedChats}개 채팅에 총 ${result.totalImported}개의 책갈피를 복원했습니다.`);
                        
                        // 현재 채팅 북마크 새로고침
                        loadBookmarks();
                        refreshBookmarkIcons();
                        // 메타데이터 로드 완료 후 모달 업데이트 (비동기 처리 고려)
                        setTimeout(() => {
                            refreshBookmarkListInModal();
                        }, 100);
                        
                        return;
                    }
                    
                    // v3.0 형식 (모든 캐릭터 포함) 지원
                    if (importData.version === '3.0' && importData.characterBookmarks && Array.isArray(importData.characterBookmarks)) {
                        console.log('[Bookmark] v3.0 형식 파일을 감지했습니다.');
                        
                        // 각 캐릭터/채팅별로 원래 위치에 불러오기
                        toastr.info(`총 ${importData.totalCharacters}개 캐릭터, ${importData.totalChats}개 채팅의 ${importData.totalBookmarks}개 책갈피를 복원하고 있습니다... 시간이 오래 걸릴 수 있습니다.`);
                        const result = await importV3ToOriginalLocations(importData.characterBookmarks);
                        
                        let successMsg = `${result.processedCharacters}개 캐릭터, ${result.processedChats}개 채팅에 총 ${result.totalImported}개의 책갈피를 복원했습니다.`;
                        if (result.notFoundCharacters.length > 0) {
                            successMsg += `\n\n찾을 수 없는 캐릭터: ${result.notFoundCharacters.join(', ')}`;
                        }
                        
                        toastr.success(successMsg);
                        
                        // 현재 채팅 북마크 새로고침
                        loadBookmarks();
                        refreshBookmarkIcons();
                        // 메타데이터 로드 완료 후 모달 업데이트 (비동기 처리 고려)
                        setTimeout(() => {
                            refreshBookmarkListInModal();
                        }, 100);
                        
                        return;
                    }
                    
                    // 지원하지 않는 형식
                    toastr.error('지원하지 않는 책갈피 파일 형식입니다.');
                    
                } catch (error) {
                    console.error('[Bookmark] 파일 파싱 실패:', error);
                    toastr.error('파일을 읽을 수 없습니다.');
                }
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    } catch (error) {
        console.error('[Bookmark] 데이터 불러오기 실패:', error);
        toastr.error('데이터 불러오기 중 오류가 발생했습니다.');
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
    console.log('[Bookmark] 채팅이 변경됨. 책갈피를 새로 로드합니다.');
    
    // 새로운 채팅의 북마크를 로드
    loadBookmarks();
    
    // 현재 채팅의 북마크 인덱스 동기화
    const context = getContext();
    if (context && context.characterId !== undefined && context.chatId !== undefined) {
        updateBookmarkIndex(context.characterId, context.chatId, bookmarks.length);
        console.log(`[Bookmark] 채팅 변경 후 인덱스 동기화: 캐릭터 ${context.characterId}, 채팅 ${context.chatId}, 책갈피 ${bookmarks.length}개`);
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
    console.log('[Bookmark] === 책갈피 매니저 초기화 시작 ===');
    
    // Extension Settings 초기화
    initializeBookmarkIndex();
    console.log('[Bookmark] Extension Settings 초기화 완료');
    
    // 책갈피 데이터 로드
    loadBookmarks();
    console.log(`[Bookmark] 책갈피 데이터 로드 완료: ${bookmarks.length}개`);
    
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
            console.log('[Bookmark] MORE_MESSAGES_LOADED 이벤트 - 아이콘 추가');
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
        console.log('[Bookmark] DOM MutationObserver 설정 완료');
    }
    
    console.log('[Bookmark] 이벤트 리스너 등록 완료');
    
    // 책갈피 아이콘 클릭 이벤트
    $(document).on('click', '.bookmark-icon', function(event) {
        console.log('[Bookmark] 책갈피 아이콘 클릭 이벤트 발생');
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        console.log(`[Bookmark] 클릭된 요소:`, this);
        console.log(`[Bookmark] 찾은 메시지 요소:`, messageElement[0]);
        console.log(`[Bookmark] 메시지 ID: ${messageId}`);
        
        if (messageId !== undefined) {
            // 이미 북마크된 메시지인지 확인
            const isBookmarked = bookmarks.some(bookmark => bookmark.messageId === parseInt(messageId));
            
            if (isBookmarked) {
                console.log(`[Bookmark] 이미 책갈피된 메시지 - 해제 확인 모달 표시`);
                showBookmarkRemoveConfirm(messageId);
            } else {
                console.log(`[Bookmark] createBookmarkModal(${messageId}) 호출`);
                createBookmarkModal(messageId);
            }
        } else {
            console.error('[Bookmark] 메시지 ID를 찾을 수 없습니다');
        }
    });
    
    // 요술봉 메뉴에 버튼 추가
    setTimeout(addToWandMenu, 1000);
    
    console.log('[Bookmark] === 북마크 매니저 초기화 완료 ===');
}

// jQuery 준비 완료 시 초기화
jQuery(() => {
    console.log('[Bookmark] jQuery 준비 완료, 책갈피 매니저 초기화 시작');
    initializeBookmarkManager();
});