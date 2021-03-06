// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import React from 'react';
import { Modal } from './Modal';
import { LocalizerType } from '../types/Util';

type PropsType = {
  i18n: LocalizerType;

  // ChatColorPicker
  isChatColorEditorVisible: boolean;
  renderChatColorPicker: () => JSX.Element;
  toggleChatColorEditor: () => unknown;

  // ProfileEditor
  isProfileEditorVisible: boolean;
  renderProfileEditor: () => JSX.Element;
};

export const GlobalModalContainer = ({
  i18n,

  // ChatColorPicker
  isChatColorEditorVisible,
  renderChatColorPicker,
  toggleChatColorEditor,

  // ProfileEditor
  isProfileEditorVisible,
  renderProfileEditor,
}: PropsType): JSX.Element | null => {
  if (isChatColorEditorVisible) {
    return (
      <Modal
        hasXButton
        i18n={i18n}
        moduleClassName="ChatColorPicker__modal"
        noMouseClose
        onClose={toggleChatColorEditor}
        title={i18n('ChatColorPicker__global-chat-color')}
      >
        {renderChatColorPicker()}
      </Modal>
    );
  }

  if (isProfileEditorVisible) {
    return renderProfileEditor();
  }

  return null;
};
