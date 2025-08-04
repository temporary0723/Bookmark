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

// 메시지 버튼 HTML (북마크 아이콘)
const messageButtonHtml = `
    <div class="mes_button bookmark-icon interactable" title="북마크 추가" tabindex="0">
        <i class="fa-solid fa-bookmark"></i>
    </div>
`;

// 북마크 데이터 저장소
let bookmarks = [];

// 현재 열린 모달
let currentModal = null;

/**
 * 로컬 스토리지에서 북마크 로드
 */
function loadBookmarks() {
    try {
        const savedBookmarks = localStorage.getItem('st_bookmarks');
        if (savedBookmarks) {
            bookmarks = JSON.parse(savedBookmarks);
        }
    } catch (error) {
        console.error('북마크 로드 실패:', error);
        bookmarks = [];
    }
}

/**
 * 로컬 스토리지에 북마크 저장
 */
function saveBookmarks() {
    try {
        localStorage.setItem('st_bookmarks', JSON.stringify(bookmarks));
    } catch (error) {
        console.error('북마크 저장 실패:', error);
    }
}

/**
 * 메시지 ID로 스크롤 이동
 */
function scrollToMessage(messageId) {
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    if (messageElement.length > 0) {
        messageElement[0].scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
        });
        
        // 강조 효과
        messageElement.addClass('highlight-bookmark');
        setTimeout(() => {
            messageElement.removeClass('highlight-bookmark');
        }, 2000);
    } else {
        toastr.warning(`메시지 ID ${messageId}를 찾을 수 없습니다.`);
    }
}

/**
 * 북마크 추가 모달 생성
 */
async function createBookmarkModal(messageId) {
    console.log(`[Bookmark] createBookmarkModal 함수 시작 - messageId: ${messageId}`);
    
    const result = await callGenericPopup(
        `메시지 ID: ${messageId}`,
        POPUP_TYPE.INPUT,
        '',
        {
            customButtons: [
                { text: '북마크 추가', result: 1 },
                { text: '취소', result: 0 }
            ]
        }
    );
    
    console.log(`[Bookmark] 모달 결과: ${result}`);
    
    if (result && result.trim()) {
        const bookmarkName = result.trim();
        console.log(`[Bookmark] 북마크 추가 - 이름: "${bookmarkName}"`);
        
        // 북마크 추가 (설명은 빈 문자열로)
        addBookmark(messageId, bookmarkName, '');
        toastr.success('북마크가 추가되었습니다.');
    } else {
        console.log('[Bookmark] 북마크 추가 취소됨');
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

    console.log('[Bookmark] 북마크 객체 생성:', bookmark);
    
    bookmarks.push(bookmark);
    bookmarks.sort((a, b) => a.messageId - b.messageId);
    
    console.log(`[Bookmark] 북마크 배열에 추가 완료. 총 ${bookmarks.length}개`);
    
    saveBookmarks();
    console.log('[Bookmark] 북마크 저장 완료');
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
        saveBookmarks();
    }
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
                <input type="text" class="bookmark-description-field text_pole" value="${bookmark.description || ''}" placeholder="북마크 설명을 입력하세요" data-bookmark-id="${bookmark.id}">
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
                    <h3>북마크 목록</h3>
                    <button class="bookmark-modal-close" title="닫기">×</button>
                </div>
                <div class="bookmark-modal-body">
                    ${bookmarks.length === 0 
                        ? '<div class="no-bookmarks">저장된 북마크가 없습니다.</div>' 
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
    
    // 북마크 클릭으로 메시지 이동
    currentModal.find('.bookmark-content').on('click', function() {
        const messageId = $(this).data('message-id');
        closeBookmarkModal();
        setTimeout(() => {
            scrollToMessage(messageId);
        }, 100);
    });

    // 설명 필드 변경 이벤트
    currentModal.find('.bookmark-description-field').on('blur', function() {
        const bookmarkId = $(this).data('bookmark-id');
        const newDescription = $(this).val().trim();
        const bookmark = bookmarks.find(b => b.id === bookmarkId);
        
        if (bookmark && bookmark.description !== newDescription) {
            bookmark.description = newDescription;
            saveBookmarks();
            console.log(`[Bookmark] 설명 자동 저장 - ID: ${bookmarkId}`);
        }
    });

    // 수정 버튼 (이름만 수정)
    currentModal.find('.bookmark-edit-btn').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        editBookmarkNameOnly(bookmarkId);
    });

    // 삭제 버튼
    currentModal.find('.bookmark-delete-btn').on('click', function(e) {
        e.stopPropagation();
        const bookmarkId = $(this).closest('.bookmark-item').data('bookmark-id');
        confirmDeleteBookmark(bookmarkId);
    });
}

/**
 * 북마크 수정 모달
 */
async function editBookmarkModal(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    console.log(`[Bookmark] 북마크 수정 모달 - ID: ${bookmarkId}`);

    // 북마크 이름 수정
    const nameResult = await callGenericPopup(
        `북마크 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        console.log('[Bookmark] 북마크 이름 수정 취소됨');
        createBookmarkListModal(); // 목록으로 돌아가기
        return;
    }

    const newName = nameResult.trim();
    if (!newName) {
        toastr.error('북마크 이름을 입력해주세요.');
        createBookmarkListModal();
        return;
    }

    // 설명 수정
    const descResult = await callGenericPopup(
        '북마크 설명 수정 (선택사항)',
        POPUP_TYPE.INPUT,
        bookmark.description || ''
    );

    if (descResult === false || descResult === null) {
        // 설명 수정을 취소해도 이름은 이미 입력했으므로 기존 설명 유지
        console.log('[Bookmark] 설명 수정 취소, 기존 설명 유지');
        editBookmark(bookmarkId, newName, bookmark.description);
        toastr.success('북마크 이름이 수정되었습니다.');
    } else {
        console.log(`[Bookmark] 북마크 수정 완료 - 이름: "${newName}", 설명: "${descResult}"`);
        editBookmark(bookmarkId, newName, descResult);
        toastr.success('북마크가 수정되었습니다.');
    }

    // 목록 새로고침
    setTimeout(() => createBookmarkListModal(), 100);
}

/**
 * 북마크 이름만 수정
 */
async function editBookmarkNameOnly(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    console.log(`[Bookmark] 북마크 이름 수정 - ID: ${bookmarkId}`);

    const nameResult = await callGenericPopup(
        `북마크 이름 수정 (메시지 ID: ${bookmark.messageId})`,
        POPUP_TYPE.INPUT,
        bookmark.name
    );

    if (nameResult === false || nameResult === null) {
        console.log('[Bookmark] 북마크 이름 수정 취소됨');
        return;
    }

    const newName = nameResult.trim();
    if (!newName) {
        toastr.error('북마크 이름을 입력해주세요.');
        return;
    }

    // 이름만 수정 (설명은 그대로 유지)
    editBookmark(bookmarkId, newName, bookmark.description);
    toastr.success('북마크 이름이 수정되었습니다.');

    // 목록 새로고침
    setTimeout(() => createBookmarkListModal(), 100);
}

/**
 * 북마크 삭제 확인
 */
async function confirmDeleteBookmark(bookmarkId) {
    const bookmark = bookmarks.find(b => b.id === bookmarkId);
    if (!bookmark) return;

    const result = await callGenericPopup(
        `"${bookmark.name}" 북마크를 삭제하시겠습니까?`,
        POPUP_TYPE.CONFIRM
    );

    if (result === POPUP_RESULT.AFFIRMATIVE) {
        deleteBookmark(bookmarkId);
        toastr.success('북마크가 삭제되었습니다.');
        
        // 목록 모달 새로고침
        closeBookmarkModal();
        setTimeout(() => createBookmarkListModal(), 100);
    }
}

/**
 * 메시지에 북마크 아이콘 추가
 */
function addBookmarkIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const extraButtonsContainer = messageElement.find('.extraMesButtons');
        
        // extraMesButtons 컨테이너가 있고 이미 버튼이 없으면 추가
        if (extraButtonsContainer.length && !extraButtonsContainer.find('.bookmark-icon').length) {
            extraButtonsContainer.prepend(messageButtonHtml);
        }
    });
}

/**
 * 메시지 업데이트 핸들러
 */
function handleMessageUpdate() {
    setTimeout(() => {
        addBookmarkIconsToMessages();
    }, 100);
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
    console.log('[Bookmark] === 북마크 매니저 초기화 시작 ===');
    
    // 북마크 데이터 로드
    loadBookmarks();
    console.log(`[Bookmark] 북마크 데이터 로드 완료: ${bookmarks.length}개`);
    
    // 기존 메시지에 아이콘 추가
    addBookmarkIconsToMessages();
    
    // 이벤트 리스너 설정
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
    eventSource.on(event_types.CHAT_CHANGED, handleMessageUpdate);
    console.log('[Bookmark] 이벤트 리스너 등록 완료');
    
    // 북마크 아이콘 클릭 이벤트
    $(document).on('click', '.bookmark-icon', function(event) {
        console.log('[Bookmark] 북마크 아이콘 클릭 이벤트 발생');
        event.preventDefault();
        event.stopPropagation();
        
        // 클릭된 메시지의 인덱스 찾기
        const messageElement = $(this).closest('.mes');
        const messageId = messageElement.attr('mesid');
        
        console.log(`[Bookmark] 클릭된 요소:`, this);
        console.log(`[Bookmark] 찾은 메시지 요소:`, messageElement[0]);
        console.log(`[Bookmark] 메시지 ID: ${messageId}`);
        
        if (messageId !== undefined) {
            console.log(`[Bookmark] createBookmarkModal(${messageId}) 호출`);
            createBookmarkModal(messageId);
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
    console.log('[Bookmark] jQuery 준비 완료, 북마크 매니저 초기화 시작');
    initializeBookmarkManager();
});